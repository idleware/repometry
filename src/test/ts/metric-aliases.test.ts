import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import type { Report } from '../../main/ts/core/model/report.js';
import { compareInspections } from '../../main/ts/core/usecases/compare.js';
import { commitSummary, repositorySummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { fileMetrics } from '../../main/ts/report/json/projections/file-metrics.js';
import { complexFunctions } from '../../main/ts/report/json/projections/inspection-details.js';
import { readReportText } from '../../main/ts/report/json/validation/report.js';
import { packJson } from '../../main/ts/report/json/wire/compact-json.js';

const formerIds = new Map([
  ['repometry.cyclomatic-complexity/v1', 'repometry.cyclomatic-babel/v1'],
  ['repometry.cognitive-complexity/v1', 'repometry.cognitive-babel/v1'],
  ['repometry.code-lines/v1', 'repometry.code-lines-babel/v1'],
  ['repometry.comment-lines/v1', 'repometry.comment-lines-babel/v1'],
  ['repometry.classes/v1', 'repometry.classes-babel/v1'],
  ['repometry.duplicated-lines/v1', 'repometry.duplicated-lines-babel/v1'],
]);
const previous = (id: string) => formerIds.get(id) ?? id;

test('previous IDs in a v2 report and packed summary header share the current history series', async () => {
  const report = await analyzeSnapshot({ excludedOutput: null, snapshot: {
    subject: { kind: 'commit', id: 'b'.repeat(40) },
    files: [{ path: 'src/fixture.js', bytes: Buffer.from('function choose(flag) { return flag ? 1 : 0; }\n') }],
  } });
  const current = { ...report, committedAt: '2026-11-21T00:00:00.000Z' };
  const data = current.pluginData!;
  for (const id of formerIds.keys()) assert.ok(data.metrics.some(metric => metric.id === id), id);
  const previousReport: Report = { ...current, subject: { kind: 'commit', id: 'a'.repeat(40) }, committedAt: '2026-11-20T00:00:00.000Z',
    definitions: Object.fromEntries(Object.entries(report.definitions).map(([id, description]) => [previous(id), description])),
    measurements: report.measurements.map(row => ({ ...row, definition: previous(row.definition) })),
    pluginData: { ...data, measured: data.measured.map(previous), metrics: data.metrics.map(metric => ({ ...metric, id: previous(metric.id) })) } };
  const previousRead = readReportText(JSON.stringify(packJson(previousReport)), previousReport.subject);
  assert.equal(JSON.stringify(previousRead), JSON.stringify(previousReport));
  assert.deepEqual(qualitySummary(previousRead), qualitySummary(current));
  assert.deepEqual(fileMetrics(previousRead).files, fileMetrics(current).files);
  assert.deepEqual(complexFunctions(previousRead), complexFunctions(current));
  assert.equal(compareInspections(previousRead, current).metrics.maxCyclomaticComplexity.delta, 0);
  const previousRow = commitSummary(previousRead);
  const currentRow = commitSummary(current);
  const oldHeader = { ...previousRow, metrics: previousRow.metrics?.map(metric => ({ ...metric, id: previous(metric.id) })) };
  const summary = repositorySummary([oldHeader, currentRow]);
  const ids = summary.metrics?.map(metric => metric.id);
  assert.deepEqual(ids, currentRow.metrics?.map(metric => metric.id));
  assert.deepEqual(summary.commits.map(row => row.values), [currentRow.values, currentRow.values]);
});
