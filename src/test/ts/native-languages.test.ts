import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { nativeLanguagePlugins } from '../../main/ts/compose/native-language-plugins.js';
import { effectivePlugins } from '../../main/ts/compose/plugin-list.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import { definitions } from '../../main/ts/core/model/measurement.js';
import { sourceFiles, workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { codeStructures } from '../../main/ts/core/model/code-structure.js';
import { execute } from '../../main/ts/core/engine/execute.js';
import { plan } from '../../main/ts/core/engine/plan.js';
import { inspectionDetails } from '../../main/ts/report/json/projections/inspection-details.js';
import { inspectionProfileDigest } from '../../main/ts/report/json/projections/inspection-context.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { readReport } from '../../main/ts/report/json/validation/report.js';

const samples = [
  { id: 'go-ast', path: 'unit.go', language: 'go', tool: 'go',
    source: 'package sample\n// Package note.\ntype Widget struct{}\nfunc (Widget) score(flag bool) int {\n  if flag && true { return 1 }\n  return func() int { return 0 }()\n}\nfunc (*Widget) reset() {}\n',
    functions: [['Widget.score', 3], [undefined, 1], ['(*Widget).reset', 1]], cognitive: 2, classes: undefined, codeLines: 7 },
  { id: 'python-ast', path: 'unit.py', language: 'python', tool: 'python3',
    source: '# Package note.\nclass Helper:\n    def run(self, flag):\n        def inner(value):\n            return 1 if value else 0\n        return inner(flag) if flag else 0\n',
    functions: [['Helper.run', 2], ['Helper.run.inner', 2]], cognitive: 2, classes: 1, codeLines: 5 },
] as const;

for (const sample of samples) {
  const plugin = nativeLanguagePlugins().find(plugin => plugin.id === sample.id);
  test(`the packaged ${sample.language} parser records only the facts it measured`, { skip: plugin?.unavailableReason }, async () => {
    const snapshot = workingSnapshot([{ path: sample.path, bytes: Buffer.from(sample.source) }]);
    const report = readReport(JSON.parse(JSON.stringify(await analyzeSnapshot({ snapshot, excludedOutput: null }))));
    assert.equal(report.status, 'complete');
    assert.equal(report.appliedConfig.profile, 'repository/v3');
    assert.deepEqual(report.scope, { files: 1, parsed: 1 });
    const measured = (id: string) => report.measurements.find(row => row.definition === id && row.target === 'file')?.value;
    assert.equal(measured(definitions.functions), sample.functions.length);
    assert.equal(measured(definitions.classes), sample.classes);
    assert.equal(measured(definitions.comments), 1);
    assert.equal(measured(definitions.codeLines), sample.codeLines);
    assert.equal(measured(definitions.cognitiveComplexity), sample.cognitive);
    assert.equal(measured(definitions.duplicatedLines), 0);
    assert.equal(qualitySummary(report).maintainability?.grade, 'A');
    assert.equal(report.ruleSkips, undefined);
    assert.deepEqual(report.measurements.filter(row => row.definition === definitions.complexity)
      .map(({ name, value }) => [name, value]), sample.functions);
    assert.equal(report.pluginData?.inventory?.[0]?.provider, `${sample.id}/parse`);
    const profile = inspectionDetails(report).profile;
    const version = profile?.analyzers.find(analyzer => analyzer.id === sample.id)?.tools[sample.tool];
    assert.match(version ?? '', /^\d+\.\d+\S*$/);
    const baseline = inspectionProfileDigest(report);
    await withToolPath('', async () => {
      const unavailable = await analyzeSnapshot({ snapshot, excludedOutput: null });
      assert.notEqual(inspectionProfileDigest(unavailable), baseline);
      assert.deepEqual(unavailable.subject, report.subject);
    });
  });
}

test('missing native tools keep their files in scope without failing inspection', async () => {
  await verifyUnavailableTools('', ['go not found on PATH', 'python3 not found on PATH']);
});

test('failed native tool version probes report the error or exit status', { skip: process.platform === 'win32' }, async t => {
  const path = await mkdtemp(join(tmpdir(), 'repometry-version-probe-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, 'go'), '#!/bin/sh\nprintf "toolchain unavailable\\nsecond line\\n" >&2\nexit 7\n', { mode: 0o700 });
  await writeFile(join(path, 'python3'), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
  await verifyUnavailableTools(path, ['go version check failed: toolchain unavailable', 'python3 version check failed: exit status 9']);
});

async function verifyUnavailableTools(path: string, reasons: readonly string[]): Promise<void> {
  await withToolPath(path, async () => {
    const snapshot = workingSnapshot(samples.map(({ path, source }) => ({ path, bytes: Buffer.from(source) })));
    const report = await analyzeSnapshot({ snapshot, excludedOutput: null,
      coverage: { text: 'SF:unit.go\nDA:3,1\nend_of_record', sourceRoot: '/repo' } });
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.scope, { files: 2, parsed: 0 });
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(report.pluginData?.inventory?.map(({ language, analysed }) => [language, analysed]), [['go', false], ['python', false]]);
    assert.equal(qualitySummary(report).maintainability, null);
    assert.equal(commitSummary(report).lineCoverage, null);
    const profile = inspectionDetails(report).profile;
    const plugins = effectivePlugins([]);
    for (const [index, { id, language }] of samples.entries()) {
      assert.equal(profile?.languages?.find(row => row.id === language)?.unavailableReason, reasons[index]);
      assert.equal(plugins.find(plugin => plugin.id === id)?.unavailableReason, reasons[index]);
    }
  });
}

test('unavailable language facts leave mixed-repository structure totals unknown', async () => {
  await withToolPath('', async () => {
    const snapshot = workingSnapshot([
      { path: 'app.js', bytes: Buffer.from('export function one() { return 1; }') },
      { path: 'unit.go', bytes: Buffer.from(samples[0].source) },
    ]);
    const report = await analyzeSnapshot({ snapshot, excludedOutput: null });
    const summary = commitSummary(report);
    assert.deepEqual(report.scope, { files: 2, parsed: 1 });
    assert.equal(summary.lines, null);
    assert.equal(summary.functions, null);
    assert.equal(summary.maxComplexity, null);
    assert.equal(summary.quality.codeLines, null);
    assert.equal(summary.quality.maintainability?.grade, null);
    for (const id of [definitions.lines, definitions.functions, definitions.complexity, definitions.codeLines, definitions.duplicatedLines]) {
      const index = summary.metrics?.findIndex(metric => metric.id === id) ?? -1;
      assert.ok(index >= 0, id);
      assert.equal(summary.values?.[index], null, id);
    }
  });
});

async function withToolPath(path: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

test('native language providers contribute real clone findings and full maintainability grades', {
  skip: !nativeLanguagePlugins().every(plugin => !plugin.unavailableReason),
}, async () => {
  const body = Array.from({ length: 12 }, (_, value) => `    total += n * ${value + 2}`).join('\n');
  const files = [
    ['a.go', `package sample\nfunc First(n int) int {\n    total := 0\n${body}\n    return total\n}\n`],
    ['b.go', `package sample\nfunc Second(n int) int {\n    total := 0\n${body}\n    return total\n}\n`],
    ['a.py', `def first(n):\n    total = 0\n${body}\n    return total\n`],
    ['b.py', `def second(n):\n    total = 0\n${body}\n    return total\n`],
  ] as const;
  const report = await analyzeSnapshot({
    snapshot: workingSnapshot(files.map(([path, source]) => ({ path, bytes: Buffer.from(source) }))), excludedOutput: null,
  });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 4, parsed: 4 });
  assert.equal(report.ruleSkips, undefined);
  const measures = report.measurements.filter(row => row.definition === definitions.duplicatedLines);
  assert.equal(measures.length, 4);
  assert.ok(measures.every(row => row.value !== null && row.value >= 12));
  assert.equal(report.findings?.filter(row => row.rule === 'similar-code').length, 2);
  const maintainability = qualitySummary(report).maintainability;
  assert.ok(maintainability?.grade);
  assert.equal(maintainability.gradeCoverage, undefined);
});

const anchorSamples = [
  { id: 'go-ast', path: 'slot.go',
    source: 'package sample\ntype Slot struct{}\nfunc (s *Slot) CompareAndSwap(a, b bool) bool {\n  if a && b { return true }\n  return func() bool { return a }()\n}\n',
    anchors: ['(*Slot).CompareAndSwap.(anonymous)', '(*Slot).CompareAndSwap'], logic: '(*Slot).CompareAndSwap' },
  { id: 'python-ast', path: 'serializer.py',
    source: 'class Serializer:\n    def loads(self, a, b):\n        if a and b:\n            return 1\n        return (lambda: 0)()\n',
    anchors: ['Serializer.loads.(anonymous)', 'Serializer.loads'], logic: 'Serializer.loads' },
] as const;

for (const sample of anchorSamples) {
  const plugin = nativeLanguagePlugins().find(plugin => plugin.id === sample.id);
  test(`the packaged ${sample.id} parser anchors observations to qualified names`, { skip: plugin?.unavailableReason }, async () => {
    const tasks = plan({ plugins: [plugin!], select: [`${sample.id}/parse`], inputs: new Map([['files', sourceFiles.id]]) });
    const results = await execute(tasks, new Map([['files', { contract: sourceFiles.id,
      value: [{ path: sample.path, bytes: Buffer.from(sample.source) }] }]]));
    const parsed = results.get(`${sample.id}/parse`);
    assert.ok(parsed?.state === 'completed' && codeStructures.accepts(parsed.product.value), JSON.stringify(parsed));
    const observed = parsed.product.value[0]?.observations ?? [];
    assert.deepEqual(observed.filter(row => row.rule === 'function-complexity').map(row => row.anchor), sample.anchors);
    assert.equal(observed.find(row => row.rule === 'boolean-logic')?.anchor, sample.logic);
    assert.equal(observed.find(row => row.rule === 'file-complexity')?.anchor, undefined);
  });
}
