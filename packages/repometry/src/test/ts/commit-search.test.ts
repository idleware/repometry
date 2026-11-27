import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitIndex, searchCommits } from '../../main/ts/report/html/app/viewer-commits.js';
import type { PublicHistoryEntry } from '../../main/ts/report/json/wire/public-history-model.js';

const entry = (sha: string, extra: Partial<PublicHistoryEntry>): PublicHistoryEntry => ({
  sha: sha.padEnd(40, '0'), generatedAt: '2026-11-21T10:00:00.000Z', status: 'complete', files: 1, parsed: 1,
  lines: 1, functions: 1, maxComplexity: 1, lineCoverage: null, ...extra,
});
const history = [
  entry('a1b2c3d', { committedAt: '2026-11-20T09:00:00.000Z', subject: 'Fix badge colours', author: { name: 'Ada Lovelace', email: 'ada@example.org' }, tags: ['v1.2.0'] }),
  entry('b4a1e5f', { committedAt: '2026-11-19T09:00:00.000Z', subject: 'Release v1.2.0 notes', author: { name: 'Grace Hopper', email: 'grace@example.org' } }),
  entry('c0ffee1', { committedAt: '2026-10-02T09:00:00.000Z', subject: 'Parse a1b2 headers', author: { name: 'Ada Lovelace', email: 'ada@example.org' } }),
];
const index = commitIndex(history);
const shas = (query: string) => searchCommits(index, query).matches.map(match => match.entry.sha.slice(0, 7));

test('commit search covers subject, tag, author, email, date and hash', () => {
  assert.deepEqual(shas(''), ['a1b2c3d', 'b4a1e5f', 'c0ffee1']);
  assert.deepEqual(shas('badge'), ['a1b2c3d']);
  assert.deepEqual(shas('lovelace'), ['a1b2c3d', 'c0ffee1']);
  assert.deepEqual(shas('grace@example'), ['b4a1e5f']);
  assert.deepEqual(shas('2026-10'), ['c0ffee1']);
  assert.deepEqual(shas('c0ff'), ['c0ffee1']);
  assert.deepEqual(shas('ada headers'), ['c0ffee1']);
  assert.deepEqual(shas('nothing-like-this'), []);
});

test('an exact tag or a hash prefix comes first; a hash matches only from its start', () => {
  assert.deepEqual(shas('v1.2.0'), ['a1b2c3d', 'b4a1e5f']);
  assert.deepEqual(shas('a1b2'), ['a1b2c3d', 'c0ffee1']);
  assert.deepEqual(shas('1b2c3d'), []);
});

test('commit search reports the total beyond the shown limit', () => {
  const many = commitIndex(Array.from({ length: 120 }, (_, n) => entry(n.toString(16).padStart(7, '0'), { subject: `Change ${n}` })));
  const result = searchCommits(many, 'change', 50);
  assert.equal(result.matches.length, 50);
  assert.equal(result.total, 120);
});
