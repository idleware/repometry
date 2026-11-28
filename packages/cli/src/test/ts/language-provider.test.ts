import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DockerToolRunner } from '../../main/ts/api/process/docker-tool-runner.js';
import { processPlugin } from '../../main/ts/api/process/plugin.js';
import { analyzeSnapshot } from './helpers/analysis.js';
import { inspect } from '../../main/ts/compose/inspect.js';
import { execute } from '@repometry/core/internal/engine/execute.js';
import { plan } from '@repometry/core/internal/engine/plan.js';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import { babelProvider } from '../../main/ts/plugins/language-js/babel-provider.js';
import type { CodeStructure } from '@repometry/core/internal/model/code-structure.js';
import { definitions, measurements } from '@repometry/core/internal/model/measurement.js';
import { sourceFile, sourceFiles, workingSnapshot } from '@repometry/core/internal/model/snapshot.js';
import type { ToolRunner } from '@repometry/core/internal/ports/tool-runner.js';
import { maintainability } from '../../main/ts/plugins/maintainability/maintainability.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import { structure } from '../../main/ts/plugins/structure/structure.js';
import { bundledPlugin } from '@repometry/core/internal/engine/plugin-manifest.js';
import { unmeasuredStructure } from '../../main/ts/compose/structure-measures.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { inspectionDetails } from '../../main/ts/report/json/projections/inspection-details.js';
import { fileMetrics } from '../../main/ts/report/json/projections/file-metrics.js';
import { readReport } from '../../main/ts/report/json/validation/report.js';

function structureFacts(path: string): CodeStructure {
  return {
    path, lines: 10, functions: 1, classes: 0, cognitiveComplexity: 3, commentLines: 1,
    cyclomaticFunctions: [{ line: 2, column: 1, name: 'choose', value: 4 }],
    cognitiveFunctions: [{ line: 2, column: 1, name: 'choose', value: 3 }],
    observations: [{ rule: 'function-parameters', value: 7, label: 'choose · Parameters', line: 2, endLine: 8 }],
    clones: { path, codeLines: [2, 3, 4, 5, 6, 7, 8], candidates: [] },
  };
}

test('structure and maintainability consume facts from a language provider without a Babel tree', async () => {
  const facts = structureFacts('fixture.js');
  assert.equal(codeStructure.accepts({ ...facts, observations: [{ rule: 'unrecognized', value: 1, label: 'Bad rule' }] }), false);
  const provider: Plugin = {
    id: 'fixture-provider', version: '1.0.0', api: pluginApi, kinds: ['language'],
    claims: { languages: ['javascript'] },
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { source: sourceFile }, output: codeStructure, execute: () => facts }],
  };
  const tasks = plan({ plugins: [provider, bundledPlugin(structure), maintainability],
    select: ['structure/size', 'structure/complexity', 'maintainability/file'], inputs: new Map([['file', sourceFile.id]]) });
  const results = await execute(tasks, new Map([['file', { contract: sourceFile.id, value: { path: facts.path, bytes: new Uint8Array() } }]]));
  const complexity = results.get('structure/complexity');
  assert.ok(complexity?.state === 'completed' && measurements.accepts(complexity.product.value));
  assert.deepEqual(complexity.product.value, [{
    definition: definitions.complexity, target: 'function', path: 'fixture.js', line: 2, column: 1, name: 'choose', value: 4,
  }]);
  const quality = results.get('maintainability/file');
  assert.ok(quality?.state === 'completed' && findingResult.accepts(quality.product.value));
  assert.equal(quality.product.value.findings[0]?.effortMinutes, 20);
  assert.equal(quality.product.value.measurements.find(row => row.definition === definitions.codeLines)?.value, 7);
});

test('an inspection uses the provider that claims the current file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-language-claims-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await Promise.all([
    writeFile(join(directory, 'a.js'), 'export const flag = true;\n'),
    writeFile(join(directory, 'b.fixture'), 'custom source\n'),
  ]);
  const provider: Plugin = {
    id: 'fixture-provider', version: '1.0.0', api: pluginApi, kinds: ['language'],
    claims: { extensions: ['.fixture'] },
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
      execute: input => structureFacts(input.read('source', sourceFile).path) }],
  };
  const metric = { id: 'fixture.functions/v1', label: 'Fixture functions', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none' } as const;
  const inspection: Plugin = {
    id: 'fixture-inspection', version: '1.0.0', api: pluginApi, kinds: ['analysis'],
    claims: { extensions: ['.js', '.fixture'] },
    produces: [{ contract: measurements.id, persistence: 'report', metrics: [metric] }],
    operations: [{ id: 'count', role: 'inspection', inputs: { syntax: codeStructure }, output: measurements, execute: input => {
      const { path, functions } = input.read('syntax', codeStructure);
      return [{ definition: metric.id, target: 'file', path, value: functions }];
    } }],
  };

  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true },
    plugins: [provider, inspection] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 2, parsed: 2 });
  assert.equal(report.measurements.find(row => row.path === 'b.fixture' && row.definition === definitions.complexity)?.value, 4);
  assert.ok(report.findings?.some(finding => finding.path === 'b.fixture'));
  assert.deepEqual(report.measurements.filter(row => row.definition === metric.id).map(row => [row.path, row.value]), [
    ['a.js', 0], ['b.fixture', 1],
  ]);
  const operations = report.appliedConfig.operations;
  assert.ok(Array.isArray(operations));
  assert.deepEqual(operations.filter(operation => operation.key === 'fixture-inspection/count').map(operation => operation.inputs), [
    { syntax: { operation: 'babel-syntax/parse' } },
    { syntax: { operation: 'fixture-provider/read' } },
  ]);
});

test('one repository-scoped language process supplies facts for all of its selected files', async t => {
  await inspectFixtureLanguage(t);
});

const image = process.env.REPOMETRY_TOOL_TEST_IMAGE;
test('a repository-scoped toy language supplies measures and display metadata through Docker', { skip: !image }, async t => {
  await inspectFixtureLanguage(t, new DockerToolRunner(image!));
});

async function inspectFixtureLanguage(t: TestContext, docker?: ToolRunner) {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-batch-provider-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const paths = ['a.fixture', 'b.fixture'];
  await Promise.all([...paths, 'excluded.fixture'].map(path => writeFile(join(directory, path), 'choose\n'.repeat(10))));
  await writeFile(join(directory, 'native.js'), 'export const flag = true;\n');
  let calls = 0;
  const parser = `
    const fs = require('node:fs');
    const parse = ${structureFacts.toString()};
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const value = input.inputs.files.files.filter(({ path }) => fs.readFileSync(path, 'utf8').startsWith('choose')).map(({ path }) => parse(path));
    process.stdout.write(JSON.stringify({ kind: 'product', contract: ${JSON.stringify(codeStructures.id)}, value }) + '\\n');
  `;
  const provider = processPlugin({
    id: 'batch-fixture', version: '1.0.0', api: pluginApi, kinds: ['language'], tools: { fixture: '1' },
    providesLanguages: [{ id: 'toy', label: 'Toy Language', color: '#123456', extensions: ['.fixture'] }],
    produces: [{ contract: codeStructures.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', scope: 'repository', inputs: { files: sourceFiles }, output: codeStructures,
      argv: ['node', '-e', parser], timeoutMs: 10_000, maxOutputBytes: 10_000 }],
  }, { network: 'none', implementation: docker?.implementation ?? 'fixture', async run(invocation) {
    calls++;
    const { files } = invocation;
    assert.deepEqual(files.map(file => file.path), paths);
    if (docker) return docker.run(invocation);
    const value = files.map(file => structureFacts(file.path));
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ kind: 'product', contract: codeStructures.id, value })), stderr: Buffer.alloc(0) };
  } });
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true },
    exclude: ['excluded.fixture'], plugins: [provider] });
  assert.equal(calls, 1);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 3, parsed: 3 });
  assert.deepEqual(report.measurements.filter(row => row.definition === definitions.complexity).map(row => [row.path, row.value]),
    [['a.fixture', 4], ['b.fixture', 4]]);
  assert.deepEqual(report.findings?.filter(finding => finding.category === 'structure').map(finding => finding.path), paths);
  const metrics = fileMetrics(readReport(JSON.parse(JSON.stringify(report))));
  assert.deepEqual(metrics.languages?.find(language => language.id === 'toy'),
    { id: 'toy', label: 'Toy Language', color: '#123456', analysed: true });
  assert.equal(metrics.files.find(file => file.path === paths[0])?.provider, 'batch-fixture/read');
  const profile = inspectionDetails(readReport(JSON.parse(JSON.stringify(report)))).profile;
  const recorded = profile?.languages;
  assert.deepEqual(recorded?.find(language => language.id === 'toy'), {
    plugin: 'batch-fixture', id: 'toy', label: 'Toy Language', extensions: ['.fixture'], globs: [],
  });
  const projected = fileMetrics(report, { id: () => 'unknown',
    catalog: [{ id: 'toy', label: 'Renamed Toy Language', color: '#ffffff' }] });
  const index = projected.files.find(file => file.path === paths[0])?.language;
  assert.equal(projected.languages?.[index!]?.label, 'Toy Language');
  assert.equal(commitSummary(readReport(JSON.parse(JSON.stringify(report)))).lines, 21);
  const diagnostic = { operation: 'batch-fixture/read', path: paths[0], state: 'partial' as const, message: 'Parse issue' };
  const partial = readReport(JSON.parse(JSON.stringify({ ...report, status: 'partial', diagnostics: [...report.diagnostics, diagnostic] })));
  const details = inspectionDetails(partial);
  assert.equal(details.metrics.status, 'partial');
  assert.deepEqual(details.diagnostics.at(-1), diagnostic);
  assert.equal(details.metrics.files.find(file => file.path === paths[0])?.diagnosticCount,
    metrics.files.find(file => file.path === paths[0])!.diagnosticCount + 1);
}

test('a partial language provider omits unsupported measures and keeps LCOV data', async () => {
  const path = 'partial.fixture';
  const facts = { path, lines: 2, functions: 1, cyclomaticFunctions: [{ line: 1, value: 2 }] };
  assert.ok(codeStructure.accepts(facts));
  const languages = [{ id: 'partial', label: 'Partial', extensions: ['.fixture'],
    measures: ['functions', 'cyclomaticComplexity'] as const }];
  const provider: Plugin = {
    id: 'partial-provider', version: '1.0.0', api: pluginApi, kinds: ['language'], providesLanguages: languages,
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
      execute: () => ({ ...facts, classes: 0, commentLines: 0, cognitiveComplexity: 0 }) }],
  };
  const report = readReport(JSON.parse(JSON.stringify(await analyzeSnapshot({
    snapshot: workingSnapshot([
      { path, bytes: Buffer.from('choose\nreturn\n') },
      { path: 'native.js', bytes: Buffer.from('export function native() { return 1; }\n[1].map(x => x + 1);\n') },
    ]),
    excludedOutput: null, coverage: { text: `SF:${path}\nDA:1,0\nend_of_record`, sourceRoot: '/repo' },
  }, [provider]))));
  assert.equal(report.status, 'complete');
  const measured = report.measurements.filter(row => row.path === path).map(row => row.definition);
  for (const id of [definitions.classes, definitions.comments, definitions.cognitiveComplexity, definitions.duplicatedLines]) {
    assert.ok(!measured.includes(id), id);
  }
  const details = inspectionDetails(report);
  assert.deepEqual(details.lineCoverage?.[path]?.uncovered, [[1, 1]]);
  assert.equal(details.functions.find(item => item.path === path)?.name, '(anonymous)');
  assert.equal(details.functions.find(item => item.path === 'native.js' && item.line === 2)?.name, '(anonymous)');
  const anonymous = report.measurements.find(row => row.path === 'native.js' && row.line === 2 && row.definition === definitions.complexity);
  assert.ok(anonymous);
  assert.ok(!Object.hasOwn(anonymous, 'name'));
  const summary = commitSummary(report);
  const cognitive = summary.metrics?.findIndex(metric => metric.id === definitions.cognitiveComplexity);
  assert.ok(cognitive !== undefined && cognitive >= 0);
  assert.equal(summary.values?.[cognitive], null);
  assert.equal(summary.quality?.cognitiveComplexity, null);
  assert.equal(summary.quality?.maintainability?.grade, 'A');
  assert.deepEqual(summary.quality?.maintainability?.gradeCoverage, { measuredFiles: 1, totalFiles: 2 });
  const file = details.metrics.files.find(item => item.path === path);
  assert.equal(file?.quality?.cognitiveComplexity, undefined);
  const detailCognitive = details.metrics.catalog?.findIndex(metric => metric.id === definitions.cognitiveComplexity);
  assert.ok(detailCognitive !== undefined && detailCognitive >= 0);
  assert.equal(file?.values?.[detailCognitive], null);
  assert.equal(details.metrics.directories.find(item => item.path === '')?.quality?.cognitiveComplexity, undefined);
  assert.ok(report.ruleSkips?.some(skip => skip.path === path && skip.plugin === 'maintainability' && skip.reason === 'unmeasured'));
});

test('JS observations carry qualified anchors', () => {
  const source = ['class Store { save() { if (a && b && c && d && e) return 1; } }',
    'const commands = { review: { run() { return 1; } } };', 'const run = () => 2;',
    'function outer() { return () => 3; }', ''].join('\n');
  const operation = babelProvider.operations[0]!;
  const facts = operation.execute({ read: () => ({ path: 'anchors.ts', bytes: Buffer.from(source) }) } as never) as CodeStructure;
  const observed = facts.observations ?? [];
  assert.deepEqual(observed.filter(row => row.rule === 'function-complexity').map(row => row.anchor),
    ['Store.save', 'commands.review.run', 'run', 'outer.(anonymous)', 'outer']);
  assert.equal(observed.find(row => row.rule === 'boolean-logic')?.anchor, 'Store.save');
  assert.equal(observed.find(row => row.rule === 'file-complexity')?.anchor, undefined);
  assert.equal(observed.find(row => row.rule === 'function-complexity')?.label, 'Store.save · Cognitive complexity');
  const names = ['Store.save', 'commands.review.run', 'run', undefined, 'outer'];
  assert.deepEqual(facts.cognitiveFunctions?.map(row => row.name), names);
  assert.deepEqual(facts.cyclomaticFunctions?.map(row => row.name), names);
});

test('the structure contract accepts anchors and rejects empty ones', () => {
  const facts = (anchor: string) => ({ path: 'a.ts', lines: 1,
    observations: [{ rule: 'function-complexity', value: 1, label: 'run · Cognitive complexity', anchor }] });
  assert.equal(codeStructure.accepts(facts('run')), true);
  assert.equal(codeStructure.accepts(facts('')), false);
});

test('Babel structures measure everything for JavaScript and TypeScript', async () => {
  const sources = { 'fixture.js': 'export function add(a, b) {\n  // sum\n  return a + b;\n}\n',
    'fixture.ts': 'export class Box<T> {\n  constructor(readonly value: T) {}\n  get(): T { return this.value; }\n}\n' };
  for (const [path, text] of Object.entries(sources)) {
    const file = { path, bytes: new TextEncoder().encode(text) };
    const facts = await babelProvider.operations[0]!.execute({ read: () => file as never });
    assert.ok(codeStructure.accepts(facts));
    assert.deepEqual(unmeasuredStructure(facts), [], path);
  }
});

test('every plugin with rules in a category skips them on files whose structure lacks that measure', async () => {
  const path = 'partial.fixture';
  const provider: Plugin = {
    id: 'partial-provider', version: '1.0.0', api: pluginApi, kinds: ['language'],
    providesLanguages: [{ id: 'partial', label: 'Partial', extensions: ['.fixture'], measures: ['functions'] }],
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
      execute: () => ({ path, lines: 1, functions: 0 }) }],
  };
  const lint: Plugin = {
    id: 'lint', version: '1.0.0', api: pluginApi, kinds: ['analysis'], claims: { extensions: ['.none'] },
    rules: [{ id: 'long-file', category: 'structure' }, { id: 'copied', category: 'duplication' }, { id: 'leak', category: 'security' }],
    produces: [{ contract: findingResult.id, persistence: 'report' }],
    operations: [{ id: 'check', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
      execute: () => ({ measurements: [], findings: [] }) }],
  };
  const report = await analyzeSnapshot({ snapshot: workingSnapshot([{ path, bytes: Buffer.from('x\n') }]), excludedOutput: null },
    [provider, lint]);
  assert.deepEqual(report.ruleSkips?.filter(skip => skip.plugin === 'lint'),
    [{ path, plugin: 'lint', rules: ['long-file', 'copied'], reason: 'unmeasured' }]);
});

test('JS try adds no nesting level; only catch is a decision that nests its body', () => {
  const source = [
    'function caught() { try { a(); } catch (error) { b(); } }',
    'function checkedTry() { try { if (p) a(); } catch (error) { b(); } }',
    'function checkedCatch() { try { a(); } catch (error) { if (p) b(); } }',
    'function finalized() { try { if (p) a(); } finally { if (q) b(); } }',
    'function nestedTry() { try { try { a(); } catch (error) { b(); } } catch (error) { c(); } }',
    '',
  ].join('\n');
  const operation = babelProvider.operations[0]!;
  const facts = operation.execute({ read: () => ({ path: 'try.js', bytes: Buffer.from(source) }) } as never) as CodeStructure;
  const observed = facts.observations ?? [];
  const depth = (name: string) => observed.find(row => row.rule === 'nested-control-flow' && row.anchor === name)?.value;
  assert.deepEqual(facts.cognitiveFunctions?.map(row => [row.name, row.value, depth(row.name!)]), [
    ['caught', 1, 1],
    ['checkedTry', 2, 1],
    ['checkedCatch', 3, 2],
    ['finalized', 2, 1],
    ['nestedTry', 2, 1],
  ]);
});
