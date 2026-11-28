import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeStructure } from '@repometry/core';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin from '@repometry/language-csharp';
import { readReport } from '../../main/ts/report/json/validation/report.js';
import { defaultCli } from './helpers/wasm-plugin.js';

const source = [
  '// File header',
  'class Fixture {',
  '  static int Wrong(int value) {',
  '    // Kept in the whole-file comment count',
  '    if (value > ) return 1;',
  '    return 0;',
  '  }',
  '  static int Nearby(int value) {',
  '    return value > 0 ? value : 0;',
  '  }',
  '}',
].join('\n');

async function parseCSharp(text: string) {
  const [parse] = plugin.create().operations;
  assert.ok(parse);
  const value = await parse.execute({ read: <T>() => ({ path: 'Fixture.cs', bytes: Buffer.from(text) }) as T });
  assert.ok(codeStructure.accepts(value));
  return value;
}

const errorAncestor = [
  '#if FEATURE', 'namespace A {', '#else', 'namespace B {', '#endif',
  '// Comments still count below the parser error.', 'class Fixture { int Neighbor() => 1; }', '}',
].join('\n');

test('C# recovers lines without measuring declarations enclosed by an error ancestor', async () => {
  const facts = await parseCSharp(errorAncestor);
  assert.equal(facts.lines, 8);
  assert.equal(facts.commentLines, 1);
  assert.deepEqual(facts.codeLines, [1, 2, 3, 4, 5, 7, 8]);
  assert.equal(facts.functions, undefined);
  assert.equal(facts.classes, undefined);
  assert.equal(facts.clones, undefined);
});

test('C# omits declarations next to a missing token or an adjacent swallowed attribute', async () => {
  const missing = await parseCSharp('class Example { int[] field = {1}int Candidate() => 3; }');
  assert.equal(missing.functions, undefined);
  const attribute = await parseCSharp([
    'class Example {', '[A(1),', '#if FEATURE', 'A(2),', '#endif',
    'A(3)]static int Candidate() => 1;', 'int Neighbor() => 2;', '}',
  ].join('\n'));
  assert.equal(attribute.classes, 0);
  assert.deepEqual(attribute.cyclomaticFunctions, [{ name: 'Example.Neighbor', line: 7, column: 1, value: 1 }]);
});

test('C# fingerprints a clean method in a damaged class', async () => {
  const body = Array.from({ length: 14 }, (_, index) => '    value = value + ' + index + ';');
  const facts = await parseCSharp(['class Example {', '  int Wrong() { int x = ; return 0; }',
    '  int Nearby(int value) {', ...body, '    return value;', '  }', '}'].join('\n'));
  assert.equal(facts.functions, 1);
  assert.equal(facts.classes, 0);
  assert.ok(facts.clones?.candidates.some(candidate => candidate.line === 3 && candidate.endLine === 19));
  assert.ok(facts.clones?.candidates.every(candidate => candidate.line >= 3));
});

test('C# is opt-in and saved recovery diagnostics do not fail an inspection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-csharp-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = join(directory, '.repometry');
  const config = join(directory, '.repometry.json');
  await Promise.all([
    writeFile(join(directory, 'main.js'), 'export const sample = 1;\n'),
    writeFile(join(directory, 'Fixture.cs'), source),
    writeFile(config, JSON.stringify({ plugins: ['@repometry/language-csharp'] })),
  ]);
  const run = (binary: string, ...args: string[]) => spawnSync(process.execPath, [binary, ...args,
    '--repo', directory, '--store', store], { encoding: 'utf8' });
  const entry = findPackageJSON('@repometry/all', import.meta.url);
  assert.ok(entry);
  const all = fileURLToPath(new URL('target/main/ts/cli/main.js', pathToFileURL(entry)));
  for (const binary of [defaultCli, all]) {
    const result = run(binary, 'analyze', '--working-tree', '--no-config');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).scope, { files: 1, parsed: 1 });
    assert.match(result.stderr, /@repometry\/language-csharp/);
  }
  const inspected = run(defaultCli, 'analyze', '--working-tree', '--config', config);
  assert.equal(inspected.status, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.scope, { files: 2, parsed: 2, recovered: 1 });
  const displayed = run(defaultCli, 'show', result.subject.id);
  assert.equal(displayed.status, 0, displayed.stderr);
  const report = readReport(JSON.parse(displayed.stdout));
  assert.deepEqual(report.scope, result.scope);
  assert.equal(report.status, 'complete');
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]!.operation, 'source/recovered');
  assert.equal(report.diagnostics[0]!.path, 'Fixture.cs');
  assert.match(report.diagnostics[0]!.message, /line 5, column \d+\. Declarations omitted: 2\./);
  const own = report.measurements.filter(row => row.path === 'Fixture.cs');
  assert.equal(own.find(row => row.definition === definitions.comments)?.value, 2);
  assert.deepEqual(own.filter(row => row.definition === definitions.complexity && row.target === 'function')
    .map(({ name, line, column, value }) => [name, line, column, value]), [['Fixture.Nearby', 8, 3, 2]]);

  await writeFile(join(directory, 'LinesOnly.cs'), errorAncestor);
  const linesOnly = run(defaultCli, 'analyze', '--working-tree', '--config', config);
  assert.equal(linesOnly.status, 0, linesOnly.stderr);
  const complete = JSON.parse(linesOnly.stdout);
  assert.deepEqual(complete.scope, { files: 3, parsed: 3, recovered: 2 });
  const saved = run(defaultCli, 'show', complete.subject.id);
  assert.equal(saved.status, 0, saved.stderr);
  const savedReport = readReport(JSON.parse(saved.stdout));
  assert.equal(savedReport.status, 'complete');
  assert.match(savedReport.diagnostics.find(row => row.path === 'LinesOnly.cs')!.message, /No declarations could be measured\./);

  await writeFile(join(directory, 'InvalidEncoding.cs'), Buffer.from([0x2f, 0x2f, 0x20, 0xff]));
  const invalid = run(defaultCli, 'analyze', '--working-tree', '--config', config);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).status, 'partial');
  assert.deepEqual(JSON.parse(invalid.stdout).scope, { files: 4, parsed: 3, recovered: 2 });
});

test('reanalyzing a commit preserves its recovery notice and recovered count', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-csharp-commit-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const config = join(directory, 'fixture.config.json');
  const store = join(directory, '.repometry');
  await Promise.all([
    writeFile(join(directory, 'Fixture.cs'), errorAncestor),
    writeFile(config, JSON.stringify({ plugins: ['@repometry/language-csharp'] })),
  ]);
  for (const args of [['init'], ['add', 'Fixture.cs'], ['commit', '-m', 'Recovery fixture']]) {
    const git = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [defaultCli, ...args, '--repo', directory, '--store', store],
    { encoding: 'utf8', env: { ...process.env, REPOMETRY_CACHE_DIR: join(directory, 'cache') } });
  const reports = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run('analyze', 'HEAD', '--config', config);
    assert.equal(result.status, 0, result.stderr);
    const analysis = JSON.parse(result.stdout);
    assert.deepEqual(analysis.scope, { files: 1, parsed: 1, recovered: 1 });
    const saved = run('show', analysis.subject.id);
    assert.equal(saved.status, 0, saved.stderr);
    const report = readReport(JSON.parse(saved.stdout));
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.status, 'complete');
    reports.push(report);
  }
  assert.deepEqual(reports[0]!.subject, reports[1]!.subject);
  assert.deepEqual(reports[0]!.diagnostics, reports[1]!.diagnostics);
});
