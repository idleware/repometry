import assert from 'node:assert/strict';
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
    await withoutTools(async () => {
      const unavailable = await analyzeSnapshot({ snapshot, excludedOutput: null });
      assert.notEqual(inspectionProfileDigest(unavailable), baseline);
      assert.deepEqual(unavailable.subject, report.subject);
    });
  });
}

test('unavailable native languages are reported without failing inspection', async () => {
  await withoutTools(async () => {
    const snapshot = workingSnapshot(samples.map(({ path, source }) => ({ path, bytes: Buffer.from(source) })));
    const report = await analyzeSnapshot({ snapshot, excludedOutput: null,
      coverage: { text: 'SF:unit.go\nDA:3,1\nend_of_record', sourceRoot: '/repo' } });
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.scope, { files: 0, parsed: 0 });
    assert.deepEqual(report.pluginData?.inventory?.map(({ language, analysed }) => [language, analysed]), [['go', false], ['python', false]]);
    const profile = inspectionDetails(report).profile;
    const plugins = effectivePlugins([]);
    for (const { id, language, tool } of samples) {
      const reason = `${tool} not found on PATH`;
      assert.equal(profile?.languages?.find(row => row.id === language)?.unavailableReason, reason);
      assert.equal(plugins.find(plugin => plugin.id === id)?.unavailableReason, reason);
    }
  });
});

async function withoutTools(run: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    await run();
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
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
