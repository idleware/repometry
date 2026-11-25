import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/inspect.js';
import { isFinding } from '../../main/ts/core/model/finding.js';
import { definitions } from '../../main/ts/core/model/measurement.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import { workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { readReport } from '../../main/ts/report/json/validation/report.js';

function scan(sources: Record<string, string>) {
  const snapshot = workingSnapshot(Object.entries(sources).map(([path, source]) => ({ path, bytes: Buffer.from(source) })));
  return analyzeSnapshot({ snapshot, excludedOutput: null });
}

test('duplicate groups retain the largest subtrees and count only distinct code lines', async () => {
  function clone(name: string, variable: string): string {
    const steps = Array.from({ length: 12 }, (_, index) => `  ${variable} = transform(${variable}, ${index});`);
    return [`function ${name}(${variable}) {`, ...steps, `  return ${variable};`, '}', ''].join('\n');
  }
  const report = readReport(JSON.parse(JSON.stringify(await scan({
    'a.js': clone('alpha', 'valueA'),
    'b.js': `// file note\n${clone('beta', 'valueB')}`,
    'c.js': 'class Unrelated {} // inline\n/* first\n * second\n */\n\n',
  }))));
  const [copy] = report.findings ?? [];
  assert.equal(report.findings?.length, 1);
  assert.equal(copy?.rule, 'similar-code');
  assert.equal(copy?.path, 'a.js');
  assert.deepEqual(copy?.related, [{ path: 'b.js', line: 2, endLine: 16 }]);
  assert.deepEqual(qualitySummary(report), {
    codeLines: 31, comments: 4, classes: 1, cognitiveComplexity: 0,
    duplication: { duplicatedLines: 30, codeLines: 31, ratio: 30 / 31 },
    maintainability: { smells: 1, effortMinutes: 30, debtRatio: 30 / (2.4 * 0.031 ** 1.05 * 9600), grade: 'A' },
  });

  const { findings: _, pluginData: _plugins, ...incomplete } = report;
  const minimal = readReport({ ...incomplete, measurements: incomplete.measurements.filter(row =>
    row.definition === definitions.lines || row.definition === definitions.functions || row.definition === definitions.complexity) });
  assert.equal(qualitySummary(minimal).maintainability, null);
});

test('nested functions have separate return counts and cognitive scores, and parse gaps suppress the project grade', async () => {
  const report = await scan({
    'valid.js': `function parent(a,b,c,d,e,f) {
  function nested(x) {
    if (a) return 1;
    if (b) return 2;
    if (c) return 3;
    if (d) return 4;
    if (e) return 5;
    if (f) return 6;
    return x;
  }
  if (a && b && c) {
    if (d) return nested(e);
  }
  return 0;
}
`,
    'invalid.js': 'function invalid(',
  });
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.findings?.map(({ rule, message }) => ({ rule, message })), [
    { rule: 'return-statements', message: 'parent.nested · Return statements 7 (limit 6)' },
    { rule: 'function-parameters', message: 'parent · Parameters 6 (limit 5)' },
  ]);
  const functions = report.measurements.filter(row => row.target === 'function' && row.definition === definitions.cognitiveComplexity);
  assert.deepEqual(functions.map(({ name, value }) => [name, value]), [['parent.nested', 6], ['parent', 4]]);
  assert.equal(qualitySummary(report).maintainability?.grade, null);
});

test('file complexity does not re-charge excess already attributed to one function', async () => {
  const body = Array.from({ length: 60 }, () => 'if (value) value += 1;').join('\n');
  const report = await scan({ 'one.js': `function complex(value) {\n${body}\nreturn value;\n}` });
  const remembered = Object.fromEntries((report.findings ?? []).map(finding => [finding.rule, finding.effortMinutes]));
  assert.equal(remembered['function-complexity'], 450);
  assert.equal(remembered['file-complexity'], 0);
  assert.equal(qualitySummary(report).maintainability?.effortMinutes, 450);
});

test('a language with fewer measures leaves repository totals unknown and stays outside the debt grade', async () => {
  const body = Array.from({ length: 60 }, () => 'if (value) value += 1;').join('\n');
  const before = await scan({ 'complete.js': `function complex(value) {\n${body}\nreturn value;\n}` });
  const path = 'partial.py';
  const selected = { files: before.scope.files + 1, parsed: before.scope.parsed + 1 };
  const partial = { ...before, scope: selected,
    ruleSkips: [{ path, plugin: 'duplication', rules: ['identical-code'], reason: 'unmeasured' as const }],
    measurements: [...before.measurements,
    { definition: definitions.lines, target: 'file' as const, path, value: 10 },
    { definition: definitions.functions, target: 'file' as const, path, value: 1 },
    { definition: definitions.complexity, target: 'function' as const, path, value: 2 },
  ] };
  const quality = qualitySummary(partial);
  assert.equal(quality.cognitiveComplexity, null);
  assert.equal(quality.classes, null);
  assert.equal(quality.comments, null);
  assert.equal(quality.duplication, null);
  assert.deepEqual(quality.maintainability, {
    ...qualitySummary(before).maintainability,
    gradeCoverage: { measuredFiles: 1, totalFiles: 2 },
  });
});

test('a file whose structural rules were unavailable has no maintainability summary', async () => {
  const report = await scan({ 'complete.js': 'export const value = 1;\n' });
  assert.equal(qualitySummary(report).maintainability?.grade, 'A');
  const skipped = { ...report, ruleSkips: [{
    path: 'complete.js', plugin: 'maintainability', rules: ['function-complexity'], reason: 'unmeasured' as const,
  }] };
  assert.equal(qualitySummary(skipped).maintainability, null);
});

function branchy(name: string, count: number): string {
  const steps = Array.from({ length: count }, (_, index) => `    if (v === ${index}) total++;`);
  return [`  ${name}(v) {`, '    let total = 0;', ...steps, '    return total;', '  }'].join('\n');
}

test('structural findings carry value, limit and anchor', async () => {
  const source = ['class Store {', branchy('save', 17), branchy('load', 17), branchy('drop', 17), '}', ''].join('\n');
  const report = await scan({ 'store.js': source });
  const shaped = report.findings?.filter(row => row.category === 'structure')
    .map(({ rule, value, limit, anchor }) => ({ rule, value, limit, anchor }));
  assert.deepEqual(shaped, [
    { rule: 'function-complexity', value: 17, limit: 15, anchor: 'Store.save' },
    { rule: 'function-complexity', value: 17, limit: 15, anchor: 'Store.load' },
    { rule: 'function-complexity', value: 17, limit: 15, anchor: 'Store.drop' },
    { rule: 'file-complexity', value: 51, limit: 50, anchor: '(file)' },
  ]);
});

test('duplicates carry their fingerprint and copy count', async () => {
  function clone(name: string, variable: string, step = 0): string {
    const steps = Array.from({ length: 12 }, (_, index) => `  ${variable} = transform(${variable}, ${index + step});`);
    return [`function ${name}(${variable}) {`, ...steps, `  return ${variable};`, '}', ''].join('\n');
  }
  const copies = { 'a.js': clone('alpha', 'valueA'), 'b.js': clone('beta', 'valueB'), 'c.js': clone('gamma', 'valueC') };
  const [group] = (await scan(copies)).findings ?? [];
  assert.equal(group?.value, 3);
  assert.equal(typeof group?.anchor, 'string');
  assert.ok(group?.anchor);
  const [edited] = (await scan({ ...copies, 'c.js': clone('gamma', 'valueC', 50) })).findings ?? [];
  assert.equal(edited?.anchor, group.anchor);
});

test('isFinding rejects a negative value and an empty anchor', () => {
  const finding = { tool: 'repometry', rule: 'function-complexity', category: 'structure', level: 'medium',
    message: 'run · Cognitive complexity 17 (limit 15)', path: 'a.js', line: 1, endLine: 3 };
  assert.equal(isFinding({ ...finding, value: 17, limit: 15, anchor: 'run' }), true);
  assert.equal(isFinding({ ...finding, value: -1 }), false);
  assert.equal(isFinding({ ...finding, limit: Number.NaN }), false);
  assert.equal(isFinding({ ...finding, anchor: '' }), false);
});
