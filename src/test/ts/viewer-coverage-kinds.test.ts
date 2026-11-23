import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableViews } from '../../main/ts/report/html/app/viewer-trends.js';
import type { TrendData } from '../../main/ts/report/html/app/viewer-trends.js';
import { formatMetric, metricValue, pluginSpec, useCatalog } from '../../main/ts/report/html/app/viewer-metrics.js';
import type { Metric } from '../../main/ts/report/html/app/viewer-metrics.js';
import type { MetricDescriptor } from '../../main/ts/report/json/wire/summary-model.js';
import type { PublicHistoryEntry } from '../../main/ts/report/json/wire/public-history-model.js';

const kind = (name: string, plural: string): MetricDescriptor[] => [
  { id: `repometry.lcov-${name}-coverage/v1`, label: `${name[0]!.toUpperCase()}${name.slice(1)} coverage`, unit: 'ratio', scope: 'file',
    aggregate: 'sum', better: 'higher', bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage',
    ratio: { of: `repometry.lcov-covered-${plural}/v1`, over: `repometry.lcov-coverable-${plural}/v1` } },
  { id: `repometry.lcov-covered-${plural}/v1`, label: `Covered ${plural}`, unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
  { id: `repometry.lcov-coverable-${plural}/v1`, label: `Measured ${plural}`, unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
];
const catalog = [...kind('branch', 'branches'), ...kind('function', 'functions')];
const commit = (sha: string, values: Record<number, number>) => ({
  sha, lineCoverage: { covered: 50, total: 100 }, values,
} as unknown as PublicHistoryEntry);
const data = (reports: PublicHistoryEntry[]): TrendData => ({ reports, quality: {}, context: null, compact: false, link: () => '' });

test('Trends lists every coverage kind the history has, after line coverage and before changed lines, without their counts', () => {
  useCatalog(catalog);
  const views = availableViews(data([commit('a'.repeat(40), { 0: 0.787, 1: 787, 2: 1000, 3: 0.62, 4: 62, 5: 100 })]));
  assert.deepEqual(views.filter(view => view.includes('coverage')), ['coverage', 'branch-coverage', 'function-coverage', 'diff-coverage']);
  assert.ok(!views.some(view => /covered|coverable/.test(view)));
});

test('a history without branch or function data keeps line coverage alone', () => {
  useCatalog([]);
  const views = availableViews(data([commit('b'.repeat(40), {})]));
  assert.deepEqual(views.filter(view => view.includes('coverage')), ['coverage', 'diff-coverage']);
  assert.equal(pluginSpec('branch-coverage'), undefined);
});

test('a kind reads as the share of its covered over its measured count, and is absent where nothing was measured', () => {
  useCatalog(catalog);
  const measured = commit('c'.repeat(40), { 1: 787, 2: 1000, 4: 62, 5: 100 });
  assert.equal(formatMetric(metricValue(measured, 'branch-coverage' as Metric, undefined)!, 'branch-coverage' as Metric), '78.7%');
  assert.equal(metricValue(measured, 'function-coverage' as Metric, undefined), 0.62);
  assert.equal(metricValue(commit('d'.repeat(40), { 1: 1, 2: 2 }), 'function-coverage' as Metric, undefined), null);
  useCatalog([]);
});
