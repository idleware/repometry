import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marked } from '../../main/ts/report/html/app/viewer-chart-line.js';
import { segments } from '../../main/ts/report/html/app/viewer-chart-points.js';
import type { ChartPoint } from '../../main/ts/report/html/app/viewer-chart-points.js';
import { trendLegend } from '../../main/ts/report/html/app/viewer-trend-points.js';
import { profileLines } from '../../main/ts/report/html/app/viewer-trend-series.js';

const at = (value: number | null, extra: Partial<ChartPoint> = {}): ChartPoint => ({
  value, label: '', title: '', href: '', current: false, partial: false, time: null,
  tip: { heading: '', commit: '', value: '', notes: [] }, ...extra,
});

test('a series joins its measured points across inspections with no value', () => {
  assert.deepEqual(segments([0.5, null, null, 0.6, null, 0.7]), [[0, 3, 5]]);
  assert.deepEqual(segments([null, 0.5, null]), []);
});

test('a profile change gets no marker, and an inspection without a value gets none either', () => {
  const points = [at(1), at(2, { boundary: 'changed' }), at(null), at(3, { boundary: 'unavailable' }), at(4)];
  assert.deepEqual(points.map((_, index) => marked(points, index, false)), [false, false, false, false, true]);
  assert.equal(marked([at(2, { flag: 'best' }), at(1), at(3)], 0, false), true);
  assert.equal(marked([at(null), at(1), at(null)], 1, false), true);
});

test('profile lines are off by default, and the footnote names them only while they are drawn', () => {
  const points = [at(1), at(2, { boundary: 'changed' })];
  assert.equal(profileLines(), false);
  assert.equal(trendLegend(points, profileLines()), '');
  assert.equal(trendLegend(points, true), 'Dashed lines mark profile changes.');
});
