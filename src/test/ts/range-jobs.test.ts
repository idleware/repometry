import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyChunks } from '../../main/ts/cli/range-jobs.js';

const mib = 1024 * 1024;
const commits = Array.from({ length: 126 }, (_, index) => String(index));

test('range workers receive balanced contiguous chunks of at least 25 commits', () => {
  const chunks = historyChunks(commits, 16, 16_384 * mib);
  assert.deepEqual(chunks.map(chunk => chunk.length), [26, 25, 25, 25, 25]);
  assert.deepEqual(chunks.flat(), commits);
  assert.deepEqual(historyChunks(commits.slice(0, 49), 16, 16_384 * mib).map(chunk => chunk.length), [49]);
  assert.deepEqual(historyChunks([], 16, 16_384 * mib), []);
});

test('available memory and an explicit serial request cap worker count', () => {
  assert.deepEqual(historyChunks(commits, 16, 1100 * mib).map(chunk => chunk.length), [63, 63]);
  assert.deepEqual(historyChunks(commits, 16, 0), [commits]);
  assert.deepEqual(historyChunks(commits, 1, 16_384 * mib), [commits]);
});
