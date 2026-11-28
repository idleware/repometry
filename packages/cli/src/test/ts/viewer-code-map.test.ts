import assert from 'node:assert/strict';
import { test } from 'node:test';
import { band, relativePeaks, spreadLevels } from '../../main/ts/report/html/app/viewer-map-scale.js';
import { entryRange } from '../../main/ts/report/html/app/viewer-table-rows.js';
import { unreadFolders } from '../../main/ts/report/html/app/viewer-totals.js';

test('a folder on the security map takes the worst level of the files inside it', () => {
  const levels = spreadLevels(new Map([['src/a/x.js', 1], ['src/a/y.js', 3], ['src/b/z.js', 2], ['root.js', 1]]));
  assert.equal(levels.get('src/a'), 3);
  assert.equal(levels.get('src/b'), 2);
  assert.equal(levels.get('src'), 3);
  assert.equal(levels.get('src/a/x.js'), 1);
  assert.equal(levels.get('root.js'), 1);
  assert.equal(levels.has(''), false);
});

test('a folder counts as not analysed only when no file inside it was read', () => {
  const folders = unreadFolders([
    { path: '.github/workflows/ci.yml', analysed: false }, { path: 'docs/a.md', analysed: false }, { path: 'docs/api/b.ts' },
    { path: 'src/c.ts', analysed: true }, { path: 'LICENSE', analysed: false },
  ]);
  assert.deepEqual([...folders].sort(), ['.github', '.github/workflows']);
});

test('a relative scale compares files with files and folders with the folders at their depth', () => {
  const peakOf = relativePeaks([
    { path: 'src', folder: true, score: 120 },
    { path: 'test', folder: true, score: 30 },
    { path: 'src/core', folder: true, score: 80 },
    { path: 'src/core/a.ts', folder: false, score: 24 },
    { path: 'src/b.ts', folder: false, score: 6 },
    { path: 'readme.md', folder: false, score: 0 },
  ]);
  assert.equal(peakOf('src/b.ts', false), 24);
  assert.equal(peakOf('src', true), 120);
  assert.equal(peakOf('test', true), 120);
  assert.equal(peakOf('src/core', true), 80);
  // A level nothing scored on still has a scale, so nothing divides by zero.
  assert.equal(relativePeaks([{ path: 'a.ts', folder: false, score: 0 }])('a.ts', false), 1);
  // The hottest file takes the hottest band, though the folders around it sum to far more.
  const file = { path: 'src/core/a.ts', lines: 1, functions: 1, diagnosticCount: 0 } as Parameters<typeof band>[0];
  assert.equal(band(file, 'churn', 24, peakOf('src/core/a.ts', false)), 4);
  assert.equal(band(file, 'churn', 24, 120), 1);
});

test('a page counts its entries, not the fold of ignored files, so the last page never passes the total', () => {
  const rows = (count: number) => Array.from({ length: count }, () => ({ kind: 'file' }));
  // 160 read files, the fold, then 37 ignored ones unfolded: 198 places, 197 files.
  const display = [...rows(160), { kind: 'unread' }, ...rows(37)];
  assert.deepEqual(entryRange(display, 150, 48), [151, 197]);
  assert.deepEqual(entryRange(display, 0, 50), [1, 50]);
  // Folded away, the last page is the fold alone after the read files.
  assert.equal(entryRange([...rows(150), { kind: 'unread' }], 150, 1), null);
});
