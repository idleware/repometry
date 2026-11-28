import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { gitExecutable } from '../../main/ts/api/git/git-executable.js';

test('Git discovery skips unusable candidates and reuses the selected executable for the same PATH', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-git-executable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unusable = join(root, 'unusable');
  const namedDirectory = join(root, 'directory');
  const first = join(root, 'first');
  const second = join(root, 'second');
  await Promise.all([mkdir(unusable), mkdir(join(namedDirectory, 'git'), { recursive: true }), mkdir(first), mkdir(second)]);
  await writeFile(join(unusable, 'git'), 'not executable');
  const selected = join(first, 'git');
  const alternate = join(second, 'git');
  for (const executable of [selected, alternate]) {
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
  }

  const searchPath = [unusable, namedDirectory, first, second].join(delimiter);
  assert.equal(gitExecutable(searchPath), selected);
  await rm(selected);
  assert.equal(gitExecutable(searchPath), selected);
  assert.equal(gitExecutable(second), alternate);
  assert.equal(gitExecutable([unusable, namedDirectory].join(delimiter)), 'git');
});

test('Git discovery leaves cwd-dependent PATH entries to the operating system', { skip: process.platform === 'win32' }, async t => {
  const absolute = await mkdtemp(join(tmpdir(), 'repometry-git-cwd-'));
  t.after(() => rm(absolute, { recursive: true, force: true }));
  const executable = join(absolute, 'git');
  await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });

  assert.equal(gitExecutable(['tools', absolute].join(delimiter)), 'git');
  assert.equal(gitExecutable(['', absolute].join(delimiter)), 'git');
  assert.equal(gitExecutable([absolute, 'tools'].join(delimiter)), executable);
});
