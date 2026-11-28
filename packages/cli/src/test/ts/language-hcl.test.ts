import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure } from '@repometry/core';
import type { CodeStructure } from '@repometry/core';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin from '@repometry/language-hcl';
import { hcl } from '@repometry/language-hcl';

const blocks = 'repometry.hcl-blocks/v1';

async function parse(path: string, source: string): Promise<CodeStructure> {
  const parse = plugin.create().operations.find(operation => operation.id === 'parse');
  assert.ok(parse);
  const result = await parse.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path, bytes: Buffer.from(source) } as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

test('HCL declares its native suffixes, line and clone measures, and source colours', () => {
  assert.equal(plugin.id, 'language-hcl');
  assert.deepEqual(plugin.tools, { '@tree-sitter-grammars/tree-sitter-hcl': '1.2.0' });
  assert.deepEqual(plugin.languages, [{
    id: 'hcl', label: 'HCL', color: '#844fba', include: ['**/*.tf', '**/*.tfvars', '**/*.hcl'],
    measures: ['codeLines', 'commentLines', 'duplication'],
    syntax: { lineComments: ['#', '//'], strings: [{ quote: '"' }], keywords: ['true', 'false', 'null'] },
  }]);
  assert.deepEqual(hcl.language.extensions, ['.tf', '.tfvars', '.hcl']);
});

test('HCL counts physical, comment and code lines without treating heredoc text as comments', async () => {
  const structure = await parse('main.tf', [
    '# HCL settings', '', 'resource "demo" "item" { // an inline note', '  /* multiline',
    '     note */', '  title = "not // or # a comment"', '  count = 1 # inline note',
    '  content = <<-EOT', '    # literal content', '    /* still literal', '  EOT', '}', '',
  ].join('\r\n'));
  assert.equal(structure.lines, 12);
  assert.equal(structure.commentLines, 3);
  assert.deepEqual(structure.codeLines, [3, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(structure.declarations, 1);
  assert.equal(structure.functions, undefined);
  assert.equal(structure.classes, undefined);
  assert.equal(structure.cognitiveComplexity, undefined);
  assert.equal(structure.cyclomaticFunctions, undefined);
  assert.equal(structure.cognitiveFunctions, undefined);
  assert.equal(structure.observations, undefined);
});

test('HCL counts named and unlabeled blocks, including nested blocks, and preserves zero', async () => {
  const example = [
    'resource "demo" "item" {', '  config = { value = 1 }', '  lifecycle {',
    '    precondition {', '      condition = true', '      error_message = "invalid"', '    }', '  }', '}',
    'locals {', '  result = [for number in [1, 2] : number if number > 1]', '}', '',
  ].join('\n');
  assert.equal((await parse('main.tf', example)).declarations, 4);
  const variables = await parse('local.tfvars', 'config = { value = 1 }\n');
  assert.equal(variables.declarations, 0);
  assert.equal((await parse('empty.hcl', '')).declarations, 0);
  assert.equal((await parse('configuration.pkr.hcl', 'source "example" "test" {}\n')).declarations, 1);
});

test('HCL fingerprints a named block and its body without erasing declaration kinds or keys', async () => {
  const source = (name: string, first: number, kind = 'resource', key = 'setting', formatted = false) => [
    kind + ' "demo" "' + name + '" {',
    ...(formatted ? ['  # An inline explanation.', ''] : []),
    ...Array.from({ length: 18 }, (_, index) => '  ' + key + index + (formatted ? '  = ' : ' = ') + (first + index)),
    '}', '',
  ].join('\n');
  const candidate = async (text: string) => {
    const { clones } = await parse('main.tf', text);
    assert.equal(clones?.scheme, 'hcl-tokens/v1');
    const definition = clones.candidates.find(item => item.start === 0);
    assert.ok(definition);
    return definition;
  };
  const raw = await candidate(source('before', 1));
  const formatted = await candidate(source('before', 1, 'resource', 'setting', true));
  const renamed = await candidate(source('after', 19));
  const differentKind = await candidate(source('before', 1, 'data'));
  const differentKey = await candidate(source('before', 1, 'resource', 'other'));
  assert.deepEqual([raw.line, raw.endLine, raw.codeLines, raw.nodes], [1, 20, 20, 59]);
  assert.deepEqual([formatted.endLine, formatted.codeLines], [22, 20]);
  assert.equal(raw.exact, formatted.exact);
  assert.equal(raw.similar, formatted.similar);
  assert.notEqual(raw.exact, renamed.exact);
  assert.equal(raw.similar, renamed.similar);
  assert.notEqual(raw.similar, differentKind.similar);
  assert.notEqual(raw.similar, differentKey.similar);
  const { clones } = await parse('main.tf', source('before', 1));
  assert.ok(clones?.candidates.some(item => item.line === 2 && item.endLine === 19 && item.nodes === 54));
  assert.deepEqual((await parse('short.tf', 'resource "demo" "item" {}\n')).clones?.candidates, []);
});

test('HCL keeps nested declaration clone ranges', async () => {
  const source = ['resource "demo" "item" {', '  lifecycle {',
    ...Array.from({ length: 18 }, (_, index) => '    setting' + index + ' = true'), '  }', '}', ''].join('\n');
  const { clones } = await parse('main.tf', source);
  assert.ok(clones?.candidates.some(item => item.line === 1 && item.endLine === 22));
  assert.ok(clones?.candidates.some(item => item.line === 2 && item.endLine === 21));
});

test('HCL rejects incomplete native syntax and keeps JSON outside its selectors', async () => {
  await assert.rejects(parse('broken.tf', 'resource "demo" "item" {\n'), { name: 'SyntaxError', message: /line [12], column [0-9]+/ });
  await assert.rejects(parse('settings.tf.json', '{}\n'), { message: 'No grammar for settings.tf.json' });
  const testFile = await parse('config.tftest.hcl', 'run "valid" {\n  command = plan\n}\n');
  assert.equal(testFile.declarations, 1);
});

test('HCL persists the block metric with line counts and clones, leaving conventional function metrics absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-hcl-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const request = { directory, output: join(directory, '.repometry'), source: { workingTree: true } as const };
  await writeFile(join(directory, 'script.js'), 'const sample = 1;\n');
  const withoutHcl = await inspect({ ...request, plugins: ['@repometry/language-hcl'] });
  assert.equal(withoutHcl.definitions[blocks], undefined);
  assert.ok(!withoutHcl.pluginData?.metrics?.some(metric => metric.id === blocks));
  const repeated = ['resource "demo" "copy" {',
    ...Array.from({ length: 18 }, (_, index) => '  setting' + index + ' = true'), '}', ''].join('\n');
  await mkdir(join(directory, '.release', '.nested'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, '.release', '.nested', 'inputs.tfvars'), 'active = true\n'),
    writeFile(join(directory, 'main.tf'), '# Configuration\n' + repeated),
    writeFile(join(directory, 'other.hcl'), repeated),
    writeFile(join(directory, 'main.tf.json'), '{}\n'),
  ]);
  const report = await inspect({ ...request, plugins: ['@repometry/language-hcl'] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 4, parsed: 4 });
  assert.deepEqual(report.measurements.filter(row => row.definition === blocks).map(({ path, value }) => [path, value]), [
    ['.release/.nested/inputs.tfvars', 0], ['main.tf', 1], ['other.hcl', 1],
  ]);
  assert.deepEqual(report.pluginData?.metrics?.find(metric => metric.id === blocks), {
    id: blocks, label: 'HCL blocks', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Size',
    description: 'Block declarations in HCL, including nested blocks.',
  });
  const values = Object.fromEntries(report.measurements.filter(row => row.path === 'main.tf').map(row => [row.definition, row.value]));
  assert.equal(values[definitions.lines], 21);
  assert.equal(values[definitions.codeLines], 20);
  assert.equal(values[definitions.comments], 1);
  assert.equal(values[definitions.duplicatedLines], 20);
  assert.equal(values[definitions.functions], undefined);
  assert.equal(values[definitions.classes], undefined);
  assert.equal(values[definitions.complexity], undefined);
  assert.equal(values[definitions.cognitiveComplexity], undefined);
  assert.ok(report.findings?.some(finding => finding.category === 'duplication' && finding.path === 'main.tf'));
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'main.tf.json')?.provider, undefined);
});
