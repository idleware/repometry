import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Metrics } from '../../main/ts/report/html/app/viewer-inspection.js';
import {
  componentRows, filteredFolderRows, folderRows, foldUnread, listSummary, notInComponent, sortRows,
} from '../../main/ts/report/html/app/viewer-table-rows.js';
import type { Row } from '../../main/ts/report/html/app/viewer-table-rows.js';
import { aggregate, ancestors } from '../../main/ts/report/html/app/viewer-totals.js';

function file(path: string, lines: number, extra: Partial<Metrics> = {}): Metrics {
  return { path, lines, functions: 1, complexity: { sum: lines, maximum: lines, measuredFunctions: 1 }, lineCoverage: null,
    diagnosticCount: 0, ...extra } as Metrics;
}

const files = [file('src/a.ts', 10), file('src/core/b.ts', 30), file('src/core/c.ts', 20), file('README.md', 5, { analysed: false })];

test('a filtered folder list totals only the files the query kept, under the folder they sit in', () => {
  const rows = filteredFolderRows(files.slice(0, 3), 'src');
  assert.deepEqual(rows.map(row => [row.kind, row.entry.path]), [['folder', 'src/core'], ['file', 'src/a.ts']]);
  assert.equal(rows[0]!.entry.lines, 50);
  assert.equal(rows[0]!.entry.complexity?.maximum, 30);
  assert.deepEqual(filteredFolderRows(files, '').map(row => row.entry.path), ['src', 'README.md']);
});

test('a folder listing takes the recorded folders right under it, then its own files', () => {
  const directories = [aggregate('', files), aggregate('src', files.slice(0, 3)), aggregate('src/core', files.slice(1, 3))];
  assert.deepEqual(folderRows(directories, files, '').map(row => [row.kind, row.entry.path]), [['folder', 'src'], ['file', 'README.md']]);
  assert.deepEqual(folderRows(directories, files, 'src').map(row => row.entry.path), ['src/core', 'src/a.ts']);
});

test('components total the chosen files they hold, and a last row gathers the files none holds', () => {
  const components = [{ component: { name: 'core' }, paths: ['src/core/b.ts', 'src/core/c.ts'] },
    { component: { name: 'docs' }, paths: ['README.md'] }] as unknown as Parameters<typeof componentRows>[0];
  const chosen = files.slice(0, 3);
  const all = componentRows(components, chosen, false);
  assert.deepEqual(all.map(row => [row.entry.path, row.entry.lines]), [['core', 50], ['docs', null], [notInComponent, 10]]);
  // A filtered list leaves out the components the query emptied.
  assert.deepEqual(componentRows(components, chosen, true).map(row => row.entry.path), ['core', notInComponent]);
});

test('sorted by path, folders come first; sorted by a figure, unmeasured rows come last either way', () => {
  const rows: Row[] = [{ entry: files[0]!, kind: 'file' }, { entry: aggregate('src/core', files.slice(1, 3)), kind: 'folder' },
    { entry: file('src/z.ts', 0, { complexity: null }), kind: 'file' }];
  assert.deepEqual(sortRows([...rows], true, entry => entry.path, true).map(row => row.entry.path), ['src/core', 'src/a.ts', 'src/z.ts']);
  const peak = (entry: Metrics) => entry.complexity?.maximum ?? null;
  assert.deepEqual(sortRows([...rows], false, peak, false).map(row => row.entry.path), ['src/core', 'src/a.ts', 'src/z.ts']);
  assert.deepEqual(sortRows([...rows], false, peak, true).map(row => row.entry.path), ['src/a.ts', 'src/core', 'src/z.ts']);
});

test('files no plugin read fold into one row at the end, unless the query asks for them or nothing else is listed', () => {
  const rows: Row[] = files.map(entry => ({ entry, kind: 'file' }));
  const folded = foldUnread(rows, new Set(), false, false);
  assert.deepEqual(folded.display.map(row => row.kind === 'unread' ? 'fold' : row.entry.path), ['src/a.ts', 'src/core/b.ts', 'src/core/c.ts', 'fold']);
  assert.deepEqual(folded.folded.map(row => row.entry.path), ['README.md']);
  assert.equal(foldUnread(rows, new Set(), false, true).display.at(-1)?.kind, 'file');
  assert.equal(foldUnread(rows, new Set(), true, false).display.length, 4);
  const onlyIgnored = foldUnread(rows.slice(3), new Set(), false, false);
  assert.deepEqual(onlyIgnored.display, rows.slice(3));
});

test('the line under the table counts what the list holds and how much of the folder the query kept', () => {
  const counts = { rows: 3, display: 3, files: 3, scope: 4, range: null };
  assert.equal(listSummary('files', counts, false, false), '3 files');
  assert.equal(listSummary('files', counts, true, false), '3 of 4 files');
  assert.equal(listSummary('folders', { ...counts, rows: 1 }, false, false), '1 entry');
  assert.equal(listSummary('folders', { ...counts, rows: 2 }, true, false), '2 entries · 3 of 4 files selected');
  assert.equal(listSummary('components', { ...counts, rows: 0 }, false, true), '');
  assert.equal(listSummary('files', { ...counts, rows: 0 }, true, false), 'No files match this selection.');
  const paged = { rows: 120, display: 121, files: 120, scope: 200, range: [51, 100] as const };
  assert.equal(listSummary('files', paged, true, false), '51–100 of 120 files · 120 of 200 files selected');
});

test('a path lists its folders nearest first', () => {
  assert.deepEqual(ancestors('src/main/ts/a.ts'), ['src/main/ts', 'src/main', 'src']);
  assert.deepEqual(ancestors('README.md'), []);
});
