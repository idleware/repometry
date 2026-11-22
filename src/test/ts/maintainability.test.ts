import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/inspect.js';
import { definitions } from '../../main/ts/core/model/measurement.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import { legacyReportSchema, readReport } from '../../main/ts/report/json/validation/report.js';
import { workingSnapshot } from '../../main/ts/core/model/snapshot.js';

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

  // Historical measurements had no finding collection or derived quality fields.
  const { findings: _, pluginData: _plugins, ...historical } = report;
  const legacy = readReport({ ...historical, schema: legacyReportSchema, measurements: historical.measurements.filter(row =>
    row.definition === definitions.lines || row.definition === definitions.functions || row.definition === definitions.complexity) });
  assert.equal(qualitySummary(legacy).maintainability, null);
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
    { rule: 'return-statements', message: 'nested · Return statements 7 (limit 6)' },
    { rule: 'function-parameters', message: 'parent · Parameters 6 (limit 5)' },
  ]);
  const functions = report.measurements.filter(row => row.target === 'function' && row.definition === definitions.cognitiveComplexity);
  assert.deepEqual(functions.map(({ name, value }) => [name, value]), [['nested', 6], ['parent', 4]]);
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
