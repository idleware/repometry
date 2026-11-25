import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { removedRanges } from '../../main/ts/api/git/changes.js';
import { readLineChanges } from '../../main/ts/api/git/line-changes.js';

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repometry-line-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  return root;
}

async function commit(root: string, files: Readonly<Record<string, string | Uint8Array | null>>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git(root, ['rm', '-q', path]);
      continue;
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'change']);
  return git(root, ['rev-parse', 'HEAD']);
}

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');

test('removed ranges read the base side of hunks', () => {
  const patch = '@@ -3 +3 @@\n-a\n+b\n@@ -5,2 +4,0 @@\n-c\n-d\n@@ -9,0 +8 @@\n+e\n';
  assert.deepEqual(removedRanges(patch), [{ first: 3, last: 3 }, { first: 5, last: 6 }]);
});

test('modified lines appear on both sides', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'src/a.ts': lines(5) });
  const head = await commit(root, { 'src/a.ts': lines(5).replace('line 3\n', 'changed\n') + 'line 6\n' });
  const { files } = await readLineChanges(root, base, head);
  assert.deepEqual(files, [{ path: 'src/a.ts', previous: 'src/a.ts', added: [{ first: 3, last: 3 }, { first: 6, last: 6 }],
    removed: [{ first: 3, last: 3 }], whole: false,
    hunks: [{ base: { first: 3, count: 1 }, head: { first: 3, count: 1 } }, { base: { first: 5, count: 0 }, head: { first: 6, count: 1 } }] }]);
});

test('an added file is added as a whole', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'keep.txt': 'keep\n' });
  const head = await commit(root, { 'src/new.ts': lines(4) });
  assert.deepEqual((await readLineChanges(root, base, head)).files,
    [{ path: 'src/new.ts', previous: null, added: [{ first: 1, last: 4 }], removed: [], whole: false, hunks: [] }]);
});

test('a deleted file is removed as a whole', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'keep.txt': 'keep\n', 'src/old.ts': lines(3) });
  const head = await commit(root, { 'src/old.ts': null });
  assert.deepEqual((await readLineChanges(root, base, head)).files,
    [{ path: null, previous: 'src/old.ts', added: [], removed: [{ first: 1, last: 3 }], whole: false, hunks: [] }]);
});

test('a rename with an edit keeps both paths', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'a.ts': lines(20) });
  git(root, ['mv', 'a.ts', 'b.ts']);
  const head = await commit(root, { 'b.ts': lines(20).replace('line 10\n', 'ten\n') });
  assert.deepEqual((await readLineChanges(root, base, head)).files,
    [{ path: 'b.ts', previous: 'a.ts', added: [{ first: 10, last: 10 }], removed: [{ first: 10, last: 10 }], whole: false,
      hunks: [{ base: { first: 10, count: 1 }, head: { first: 10, count: 1 } }] }]);
});

test('binary and undecodable files change as a whole', async t => {
  const root = await repository(t);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const base = await commit(root, { 'image.png': png, 'latin.txt': Uint8Array.from([0x61, 0x0a]) });
  const head = await commit(root, { 'image.png': Uint8Array.from([...png, 1]), 'latin.txt': Uint8Array.from([0x61, 0xe9, 0x0a]) });
  assert.deepEqual((await readLineChanges(root, base, head)).files, [
    { path: 'image.png', previous: 'image.png', added: [], removed: [], whole: true, hunks: [] },
    { path: 'latin.txt', previous: 'latin.txt', added: [], removed: [], whole: true, hunks: [] },
  ]);
});

test('CRLF files report physical lines', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'win.ts': 'a\r\nb\r\nc\r\n' });
  const head = await commit(root, { 'win.ts': 'a\r\nB\r\nc\r\n' });
  assert.deepEqual((await readLineChanges(root, base, head)).files,
    [{ path: 'win.ts', previous: 'win.ts', added: [{ first: 2, last: 2 }], removed: [{ first: 2, last: 2 }], whole: false,
      hunks: [{ base: { first: 2, count: 1 }, head: { first: 2, count: 1 } }] }]);
});

test('every regular file counts, not only sources', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'Dockerfile': 'FROM node\n', 'package.json': '{}\n' });
  const head = await commit(root, { 'Dockerfile': 'FROM node:24\n', 'package.json': '{"name":"x"}\n' });
  assert.deepEqual((await readLineChanges(root, base, head)).files.map(file => file.path), ['Dockerfile', 'package.json']);
});

test('the same commit has no changes', async t => {
  const root = await repository(t);
  const base = await commit(root, { 'a.ts': 'a\n' });
  assert.deepEqual(await readLineChanges(root, base, base), { files: [] });
});
