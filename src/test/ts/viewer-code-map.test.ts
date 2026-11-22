import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spreadLevels, unreadFolders } from '../../main/ts/report/html/app/viewer-files.js';

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
