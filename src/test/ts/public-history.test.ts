import assert from 'node:assert/strict';
import { test } from 'node:test';
import { siteSummary } from '../../main/ts/report/html/site/export-site.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { axisLabels, tickLabels, timeTicks } from '../../main/ts/report/html/app/viewer-chart-time.js';
import { stableWindow } from '../../main/ts/report/html/app/viewer-trend-data.js';
import { plantFlags } from '../../main/ts/report/html/app/viewer-trend-points.js';
import { reportSchema } from '../../main/ts/report/json/validation/report.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';

test('commit summaries prefer the explicit commit time and recover it from saved churn windows', () => {
  const endingAt = '2026-07-23T20:10:36.000Z';
  const committedAt = '2026-07-24T20:10:36.000Z';
  const config = { churnWindow: { endingAt, commits: 3, shallow: false, capReached: false } };
  const dated = commitSummary({ ...report('a', config), committedAt });
  const historical = commitSummary(report('b', config));
  const undated = commitSummary(report('c', { churnWindow: { endingAt: 'invalid' } }));
  assert.equal(dated.committedAt, committedAt);
  assert.equal(historical.committedAt, endingAt);
  assert.ok(!('committedAt' in undated));
  const summary = JSON.parse(siteSummary([historical, dated, undated], {}).toString());
  assert.deepEqual(summary.commits.map(({ committedAt }: { committedAt?: string }) => committedAt), [committedAt, endingAt, undefined]);
});

test('time ticks follow the calendar and keep labels apart', () => {
  const start = Date.parse('2026-06-13T04:35:41Z');
  const end = Date.parse('2026-11-20T07:33:47Z');
  const ticks = timeTicks(start, end, 640);
  assert.ok(ticks.length >= 4 && ticks.length <= 10, `${ticks.length} ticks`);
  for (const tick of ticks) {
    const date = new Date(tick.time);
    assert.equal(date.getDate(), 1);
    assert.equal(date.getHours(), 0);
  }
  const narrow = timeTicks(start, end, 280);
  assert.ok(narrow.length < ticks.length && narrow.length >= 2);
  const hours = timeTicks(Date.parse('2026-11-10T08:00:00Z'), Date.parse('2026-11-10T16:00:00Z'), 640);
  assert.ok(hours.length >= 3 && hours.every(tick => new Date(tick.time).getMinutes() === 0));
});

function report(key: string, appliedConfig: Report['appliedConfig']): Report {
  return { schema: reportSchema, subject: { kind: 'commit', id: key.repeat(40) },
    generatedAt: '2026-11-21T00:00:00.000Z', status: 'complete', scope: { files: 1, parsed: 1 },
    appliedConfig, definitions: {}, diagnostics: [], measurements: [] };
}

test('flags stand on the best and the worst value, where each was first reached', () => {
  assert.deepEqual(plantFlags([0.4, 0.3, 0.3, null, 0.5, 0.5], 'debt'), { best: 1, worst: 4 });
  assert.deepEqual(plantFlags([0.6, 0.8, 0.7], 'coverage'), { best: 1, worst: 0 });
  assert.deepEqual(plantFlags([10, 20, 30], 'lines'), { best: null, worst: null });
  assert.deepEqual(plantFlags([0.4, 0.5], 'debt'), { best: null, worst: null });
  assert.deepEqual(plantFlags([0.4, 0.4, 0.4], 'debt'), { best: null, worst: null });
});

test('a first value within rounding of both extremes still leaves both flags, each where the line first reaches it', () => {
  // zurk's debt ratio over all inspections: 0.144% first, 0.114% at best and 0.188% at worst, a range shown as 0.1 pp.
  // A tolerant "beats" let the first value stand for both ends, and the flags vanished.
  assert.deepEqual(plantFlags([0.00144, 0.0013, 0.00114, 0.00114, null, 0.00188, 0.00188], 'debt'), { best: 2, worst: 5 });
  assert.deepEqual(plantFlags([0.00188, 0.00144, 0.00114], 'debt'), { best: 2, worst: 0 });
  assert.deepEqual(plantFlags([0.1 + 0.2, 0.5, 0.3], 'coverage'), { best: 1, worst: 0 });
  assert.deepEqual(plantFlags([0.00144, 0.00114, 0.00135], 'debt'), { best: null, worst: null });
});

test('commits within an hour get minute ticks', () => {
  const ticks = timeTicks(Date.parse('2026-11-19T22:00:00Z'), Date.parse('2026-11-19T22:55:00Z'), 640);
  assert.ok(ticks.length >= 3, `${ticks.length} ticks`);
  assert.ok(ticks.every(tick => new Date(tick.time).getMinutes() % 5 === 0));
});

test('a long span gets ticks one calendar period apart', () => {
  const ticks = timeTicks(Date.parse('2023-07-10T00:00:00'), Date.parse('2025-05-20T00:00:00'), 900);
  assert.ok(ticks.length >= 4, `${ticks.length} ticks`);
  const months = ticks.map(tick => new Date(tick.time).getFullYear() * 12 + new Date(tick.time).getMonth());
  const steps = new Set(months.slice(1).map((month, index) => month - months[index]!));
  assert.equal(steps.size, 1, 'every tick is the same number of months after the last');
  assert.ok(ticks.every(tick => new Date(tick.time).getDate() === 1));
  assert.match(ticks[0]!.label, /20\d\d/);
});

test('tick labels name the coarser unit only where it changes', () => {
  const months = ['2023-07-01', '2023-11-01', '2023-12-01', '2024-01-01', '2024-02-01'].map(day => Date.parse(`${day}T00:00:00`));
  const labels = tickLabels(months, 'month');
  assert.deepEqual(labels.map(label => /\d{4}/.exec(label)?.[0] ?? null), ['2023', null, null, '2024', null]);
  const days = ['2026-06-30', '2026-07-01', '2026-07-02'].map(day => Date.parse(`${day}T00:00:00`));
  const [first, next, plain] = tickLabels(days, 'day');
  assert.match(first!, /2026/);
  assert.doesNotMatch(next!, /2026/);
  assert.equal(plain, '2');
});

test('the first label shown carries the date even when the first tick loses its label', () => {
  // Day ticks from 4 to 12 Nov; the 4th stands at the very edge, where its label cannot sit.
  const ticks = Array.from({ length: 9 }, (_, index) => ({ time: Date.parse(`2026-11-${String(4 + index).padStart(2, '0')}T00:00:00`), x: 2 + index * 85 }));
  const labels = axisLabels(ticks, 'day', { left: 0, plotWidth: 760 } as never).map(item => item.label);
  assert.match(labels[0]!, /Nov/);
  assert.match(labels[0]!, /2026/);
  assert.ok(labels.slice(1).every(label => /^\d+$/.test(label)), labels.join(' · '));
});

test('a chart window stays put while the selection moves inside it', () => {
  const reports = Array.from({ length: 200 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0') })) as never[];
  assert.deepEqual(stableWindow(reports, 5, 60, 'test'), { start: 0, end: 60 });
  // Outside the newest slice: centred on the pick.
  assert.deepEqual(stableWindow(reports, 120, 60, 'test'), { start: 90, end: 150 });
  // Inside the current slice: unchanged.
  assert.deepEqual(stableWindow(reports, 95, 60, 'test'), { start: 90, end: 150 });
  assert.deepEqual(stableWindow(reports, 149, 60, 'test'), { start: 90, end: 150 });
  // Near the oldest end the slice stops at the edge.
  assert.deepEqual(stableWindow(reports, 199, 60, 'test'), { start: 140, end: 200 });
});
