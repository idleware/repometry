import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeSnapshot } from './helpers/analysis.js';
import { inspect } from '../../main/ts/compose/inspect.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract, MetricDescriptor, Plugin } from '../../main/ts/core/engine/plugin.js';
import { definitions, measurements } from '../../main/ts/core/model/measurement.js';
import { cloneSources } from '../../main/ts/core/model/clone-source.js';
import { codeStructure } from '../../main/ts/core/model/code-structure.js';
import { lcovInput } from '../../main/ts/core/model/coverage-input.js';
import { findingResult } from '../../main/ts/core/model/finding.js';
import { sourceFile } from '../../main/ts/core/model/snapshot.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import { inspectionAsset } from '../../main/ts/report/json/projections/inspection-details.js';
import { commitSummary, repositorySummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { validateSummary } from '../../main/ts/report/json/validation/summary-validation.js';

const metric: MetricDescriptor = {
  id: 'fixture.todo-count/v1', label: 'TODO comments', unit: 'count', scope: 'file', aggregate: 'sum', better: 'lower',
};
const evidence: DataContract<number> = { id: 'fixture.evidence/v1', accepts: (value): value is number => typeof value === 'number' };
const transient: DataContract<number> = { ...evidence, id: 'fixture.transient/v1' };

const fixture: Plugin = {
  id: 'fixture', api: pluginApi, version: '1.0.0', kinds: ['analysis'],
  claims: { extensions: ['.js'] },
  produces: [
    { contract: measurements.id, persistence: 'report', metrics: [metric] },
    { contract: evidence.id, persistence: 'report', schema: { type: 'integer', minimum: 0 } },
    { contract: transient.id, persistence: 'transient' },
  ],
  rules: [{ id: 'todos', category: 'structure', measure: metric.id }],
  operations: [
    { id: 'count', role: 'inspection', inputs: { source: sourceFile }, output: measurements, execute(inputs) {
      const file = inputs.read('source', sourceFile);
      const value = [...new TextDecoder().decode(file.bytes).matchAll(/TODO/g)].length;
      return [{ definition: metric.id, target: 'file', path: file.path, value }];
    } },
    { id: 'evidence', role: 'inspection', inputs: { source: sourceFile }, output: evidence,
      execute: inputs => inputs.read('source', sourceFile).bytes.length },
    { id: 'debug', role: 'inspection', inputs: { source: sourceFile }, output: transient, execute: () => 99 },
  ],
};

const input = { excludedOutput: null, snapshot: { subject: { kind: 'commit', id: 'a'.repeat(40) } as const,
  files: [{ path: 'a.js', bytes: new TextEncoder().encode('// TODO\nexport const a = 1;') }],
  inventory: [{ path: 'a.js', lines: 2 }, { path: 'README.md', lines: 4 }] } };

test('an operation can contribute more rows than the JavaScript argument limit', async () => {
  const count = 140_000;
  const operation = { ...fixture.operations[0]!, execute: () =>
    Array.from({ length: count }, (_, value) => ({ definition: metric.id, target: 'file', path: 'a.js', value })) };
  const report = await analyzeSnapshot(input, [{ ...fixture, operations: [operation] }]);
  const measured = report.measurements.filter(row => row.definition === metric.id);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(measured.length, count);
  assert.equal(measured.at(-1)?.value, count - 1);
});

test('inspect routes files claimed by a registered plugin and saves its results', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-registered-plugin-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const output = join(directory, '.repometry');
  await Promise.all(['notes.txt', 'other.md', 'excluded.txt'].map(path => writeFile(join(directory, path), 'TODO\n')));
  const plugin = { ...fixture, claims: { extensions: ['.txt'] } };
  const request = { directory, output, source: { workingTree: true } as const, exclude: ['excluded.txt'], plugins: [plugin] };

  const report = await inspect(request);
  assert.deepEqual(report.measurements.filter(row => row.definition === metric.id), [
    { definition: metric.id, target: 'file', path: 'notes.txt', value: 1 },
  ]);
  assert.ok(report.pluginData?.inventory?.some(file => file.path === 'notes.txt' && file.analysed));
  assert.deepEqual((await new LocalReportStore(output).read(report.subject)).pluginData, report.pluginData);
});

const noFindings = () => ({ measurements: [], findings: [] });
const findingsOnly = [{ contract: findingResult.id, persistence: 'report' as const }];

test('a plugin that claims JavaScript and derives its own code structure is rejected: only a language provider supplies it', async () => {
  const plugin: Plugin = { id: 'restructure', api: pluginApi, version: '1.0.0', kinds: ['analysis'], claims: { extensions: ['.js'] },
    produces: [{ contract: codeStructure.id, persistence: 'transient' }, ...findingsOnly], operations: [
      { id: 'derive', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
        execute: inputs => ({ path: inputs.read('source', sourceFile).path, functions: [] }) },
      { id: 'check', role: 'inspection', inputs: { source: sourceFile }, output: findingResult, execute: noFindings },
    ] };
  await assert.rejects(analyzeSnapshot(input, [plugin]),
    { message: 'restructure/derive outputs repometry.code-structure/v1, which only a language provider supplies' });
  const report = await analyzeSnapshot(input, [{ ...plugin, operations: plugin.operations.filter(({ role }) => role === 'inspection') }]);
  assert.deepEqual(report.diagnostics, []);
  const keys = (report.appliedConfig.operations as { key: string; inputs: unknown }[]).map(({ key, inputs }) => [key, inputs]);
  assert.deepEqual(keys.filter(([key]) => key === 'structure/size' || key === 'restructure/check'), [
    ['structure/size', { syntax: { operation: 'babel-syntax/parse' } }], ['restructure/check', { source: { external: 'file' } }]]);
});

test('every plugin runs its operations in the phase their inputs name', async () => {
  const received: unknown[] = [];
  const parsed: string[] = [];
  const plugin: Plugin = { id: 'phases', api: pluginApi, version: '1.0.0', kinds: ['analysis'], produces: findingsOnly, operations: [
    { id: 'clones', role: 'inspection', inputs: { sources: cloneSources }, output: findingResult,
      execute: inputs => (received.push(inputs.read('sources', cloneSources).map(({ path, scheme }) => ({ path, scheme }))), noFindings()) },
    { id: 'syntax', role: 'inspection', inputs: { syntax: codeStructure }, output: findingResult,
      execute: inputs => (parsed.push(inputs.read('syntax', codeStructure).path), noFindings()) },
    { id: 'lines', role: 'inspection', inputs: { lcov: lcovInput }, output: findingResult, execute: noFindings },
  ] };
  const report = await analyzeSnapshot(input, [plugin]);
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(received, [[{ path: 'a.js', scheme: 'babel-syntax' }]]);
  assert.deepEqual(parsed, ['a.js']);
  const keys = (report.appliedConfig.operations as { key: string }[]).map(({ key }) => key);
  assert.deepEqual(keys.filter(key => key.startsWith('phases/')), ['phases/syntax', 'phases/clones']);
  const unoffered = { ...plugin, operations: [{ ...plugin.operations[0]!, inputs: { a: cloneSources, b: codeStructure } }] };
  await assert.rejects(analyzeSnapshot(input, [unoffered]), /phases\/clones reads .*which no phase of its runs offers together/);
});

test('declared metrics, rules and custom JSON products round-trip through the report store', async t => {
  const output = await mkdtemp(tmpdir() + '/repometry-plugin-report-');
  t.after(() => rm(output, { force: true, recursive: true }));
  const report = await analyzeSnapshot(input, [fixture]);
  assert.equal(report.status, 'complete');
  assert.equal(report.measurements.find(row => row.definition === metric.id)?.value, 1);
  assert.deepEqual(report.pluginData?.metrics.find(item => item.id === metric.id), metric);
  assert.deepEqual(report.pluginData?.rules.find(item => item.plugin === 'fixture')?.rules, fixture.rules);
  assert.deepEqual(report.pluginData?.products, {
    [evidence.id]: [{ operation: 'fixture/evidence', path: 'a.js', value: input.snapshot.files[0]!.bytes.length }],
  });
  assert.deepEqual(report.pluginData?.contracts?.[evidence.id], { type: 'integer', minimum: 0 });
  const store = new LocalReportStore(output);
  await store.save(report);
  assert.deepEqual((await store.read(report.subject)).pluginData, report.pluginData);
});

test('a plugin value that passes its predicate still fails when it violates the declared JSON schema', async () => {
  const bad = { ...fixture, operations: fixture.operations.map(operation => operation.id === 'evidence'
    ? { ...operation, execute: () => -1 } : operation) };
  const report = await analyzeSnapshot(input, [bad]);
  assert.equal(report.status, 'partial');
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.operation === 'fixture/evidence' && /schema/i.test(diagnostic.message)));
  assert.equal(report.pluginData?.products[evidence.id], undefined);
});

test('fixture metrics flow into the saved summary and file details by catalog index', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-plugin-summary-'));
  t.after(() => rm(output, { force: true, recursive: true }));
  const store = new LocalReportStore(output);
  const report = await analyzeSnapshot({
    ...input, snapshot: { ...input.snapshot, files: [...input.snapshot.files,
      { path: 'b.js', bytes: new TextEncoder().encode('export const b = 2;') }] },
  }, [fixture]);
  await store.save(report);
  await store.save({ ...await analyzeSnapshot(input), subject: { kind: 'commit', id: 'b'.repeat(40) } });
  const summary: unknown = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.ok(validateSummary(summary));
  const index = summary.metrics?.findIndex(item => item.id === metric.id) ?? -1;
  assert.ok(index >= 0);
  assert.equal(summary.commits.find(item => item.sha === report.subject.id)?.values?.[index], 1);
  assert.equal(summary.commits.find(item => item.sha === 'b'.repeat(40))?.values?.[index], undefined);
  const details = inspectionAsset(report, undefined).inspection.metrics;
  const column = details.catalog?.findIndex(item => item.id === metric.id) ?? -1;
  assert.ok(column >= 0);
  assert.equal(details.files.find(file => file.path === 'a.js')?.values?.[column], 1);
  assert.equal(details.files.find(file => file.path === 'b.js')?.values?.[column], undefined);
  const markdown = details.files.find(file => file.path === 'README.md');
  assert.equal(markdown?.lines, 4);
  assert.equal(markdown?.analysed, false);
  assert.equal(details.languages?.[markdown!.language!]?.id, 'markdown');
  const catalog = inspectionAsset(report, undefined).inspection.profile?.ruleCatalog;
  assert.ok(catalog?.some(rule => rule.source === 'fixture' && rule.rule === 'todos'));
});

test('generic coverage aggregates weighted counts and public summaries omit security plugin metrics', async () => {
  const report = await analyzeSnapshot({
    ...input,
    snapshot: { ...input.snapshot, files: [
      { path: 'a.js', bytes: new TextEncoder().encode('export const a = 1;') },
      { path: 'b.js', bytes: new TextEncoder().encode('export const b = 2;\nexport const c = 3;') },
    ] },
    coverage: { sourceRoot: '/', text: 'SF:a.js\nDA:1,1\nend_of_record\nSF:b.js\nDA:1,0\nDA:2,0\nend_of_record\n' },
  }, [{ ...fixture, kinds: ['security'] }]);
  const row = commitSummary(report);
  const publicSummary = repositorySummary([row], undefined, false);
  const position = publicSummary.metrics?.findIndex(item => item.id === definitions.coverage) ?? -1;
  assert.ok(position >= 0);
  assert.equal(publicSummary.commits[0]?.values?.[position], 1 / 3);
  assert.ok(!publicSummary.metrics?.some(item => item.id === metric.id));
  assert.ok(repositorySummary([row]).metrics?.some(item => item.id === metric.id));
});
