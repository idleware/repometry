import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from './helpers/analysis.js';
import { HistoryCache } from '../../main/ts/compose/history-cache.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { Plugin } from '../../main/ts/core/engine/plugin.js';
import { codeStructures } from '../../main/ts/core/model/code-structure.js';
import { definitions, measurements } from '../../main/ts/core/model/measurement.js';
import { digest, sourceFile, sourceFiles } from '../../main/ts/core/model/snapshot.js';
import type { AnalysisInput } from '../../main/ts/core/usecases/inspect.js';

function input(entries: Record<string, string>, excludedPaths: readonly string[] = []): AnalysisInput {
  const files = Object.entries(entries).map(([path, source]) => ({ path, bytes: Buffer.from(source) }));
  return { snapshot: { subject: { kind: 'commit', id: digest(JSON.stringify(entries)) }, files,
    blobIds: new Map(files.map(({ path, bytes }) => [path, digest(bytes)])) }, excludedOutput: null, excludedPaths };
}

test('range reuse depends on path, blob, profile and every plugin version', async () => {
  const calls: string[] = [];
  const cache = new HistoryCache();
  const plugin: Plugin = { id: 'test-file', version: '1', api: pluginApi, kinds: ['analysis'],
    claims: { extensions: ['.js'] }, produces: [{ contract: measurements.id, persistence: 'report' }],
    operations: [{ id: 'count', role: 'inspection', inputs: { file: sourceFile }, output: measurements, execute(inputs) {
      calls.push(inputs.read('file', sourceFile).path);
      return [];
    } }],
  };
  const old = input({ 'a.js': 'let x = 1;', 'b.js': 'let y = 1;' });
  const newer = input({ 'a.js': 'let x = 1;', 'c.js': 'let y = 1;' });
  await analyzeSnapshot(old, [plugin], undefined, cache);
  await analyzeSnapshot(newer, [plugin], undefined, cache);
  assert.deepEqual(calls.splice(0), ['a.js', 'b.js', 'c.js']);
  await analyzeSnapshot(input({ 'a.js': 'let x = 2;', 'c.js': 'let y = 1;' }), [plugin], undefined, cache);
  assert.deepEqual(calls.splice(0), ['a.js']);
  await analyzeSnapshot({ ...newer, excludedPaths: ['vendor/**'] }, [plugin], undefined, cache);
  assert.deepEqual(calls.splice(0), ['a.js', 'c.js']);
  await analyzeSnapshot({ ...newer, excludedPaths: ['vendor/**'] }, [{ ...plugin, version: '2' }], undefined, cache);
  assert.deepEqual(calls, ['a.js', 'c.js']);
});

test('batch reuse requires file independence and retries the full batch if the subset diagnoses a file', async () => {
  for (const fileIndependent of [true, undefined]) {
    const calls: string[][] = [];
    const cache = new HistoryCache();
    const provider: Plugin = { id: 'test-batch', version: '1', api: pluginApi, kinds: ['language'],
      claims: { extensions: ['.fixture'] }, produces: [{ contract: codeStructures.id, persistence: 'transient' }],
      operations: [{ id: 'parse', role: 'provider', scope: 'repository', fileIndependent,
        inputs: { files: sourceFiles }, output: codeStructures, execute(inputs) {
          const files = inputs.read('files', sourceFiles);
          calls.push(files.map(({ path }) => path));
          for (const { path, bytes } of files) if (bytes[0] === 33) inputs.emitDiagnostic?.(`Parse warning: ${path}`);
          return files.map(({ path }) => ({ path, lines: 1 }));
        } }],
    };
    await analyzeSnapshot(input({ 'a.fixture': 'a', 'b.fixture': 'b' }), [provider], undefined, cache);
    await analyzeSnapshot(input({ 'a.fixture': 'a', 'b.fixture': 'c' }), [provider], undefined, cache);
    const snapshot = input({ 'a.fixture': 'a', 'b.fixture': '!' });
    const result = await analyzeSnapshot(snapshot, [provider], undefined, cache);
    const uncached = await analyzeSnapshot(snapshot, [provider]);
    const paths = ['a.fixture', 'b.fixture'];
    const subset = ['b.fixture'];
    assert.deepEqual(calls, fileIndependent ? [paths, subset, subset, paths, paths] : [paths, paths, paths, paths]);
    assert.deepEqual({ ...result, generatedAt: '' }, { ...uncached, generatedAt: '' });
  }
});

test('unchanged file facts still produce fresh clone groups and coverage for each revision', async () => {
  const history = new HistoryCache();
  const body = Array.from({ length: 12 }, (_, index) => `  x = transform(x, ${index});`).join('\n');
  const source = `function copy(x) {\n${body}\n  return x;\n}\n`;
  const coverage = (hits: number) => ({ text: `SF:a.js\nDA:2,${hits}\nend_of_record\n`, sourceRoot: '/repo' });
  const old = { ...input({ 'a.js': source }), coverage: coverage(1) };
  const next = { ...input({ 'a.js': source, 'b.js': source }), coverage: coverage(0) };
  const before = await analyzeSnapshot(old, [], undefined, history);
  const after = await analyzeSnapshot(next, [], undefined, history);
  const baseline = await analyzeSnapshot(next);
  assert.equal(before.findings?.some(({ category }) => category === 'duplication'), false);
  assert.equal(after.findings?.some(({ category, path, related }) => category === 'duplication'
    && path === 'a.js' && related?.[0]?.path === 'b.js'), true);
  assert.ok(before.measurements.some(({ definition, value }) => definition === definitions.coverage && value === 1));
  assert.ok(after.measurements.some(({ definition, value }) => definition === definitions.coverage && value === 0));
  assert.deepEqual({ ...after, generatedAt: '' }, { ...baseline, generatedAt: '' });
});
