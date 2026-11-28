import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorLabel, commitIndex, searchCommits } from '../../main/ts/report/html/app/viewer-commits.js';
import type { PublicHistoryEntry } from '../../main/ts/report/json/wire/public-history-model.js';

const entry = (sha: string, extra: Partial<PublicHistoryEntry>): PublicHistoryEntry => ({
  sha: sha.padEnd(40, '0'), generatedAt: '2026-11-21T10:00:00.000Z', status: 'complete', files: 1, parsed: 1,
  lines: 1, functions: 1, maxComplexity: 1, lineCoverage: null, ...extra,
});

test('a public history names authors without emails, and search and labels still read them by name', () => {
  const history = [
    entry('a1b2c3d', { committedAt: '2026-11-20T09:00:00.000Z', subject: 'Fix badge colours', author: { name: 'Ada Lovelace' } }),
    entry('b4a1e5f', { committedAt: '2026-11-19T09:00:00.000Z', subject: 'Release notes', author: { name: 'Grace Hopper' } }),
    entry('c0ffee1', { committedAt: '2026-10-02T09:00:00.000Z', subject: 'Parse headers' }),
  ];
  const index = commitIndex(history);
  const shas = (query: string) => searchCommits(index, query).matches.map(match => match.entry.sha.slice(0, 7));
  assert.deepEqual(shas('lovelace'), ['a1b2c3d']);
  assert.deepEqual(shas('grace hopper'), ['b4a1e5f']);
  assert.deepEqual(shas('undefined'), []);
  assert.deepEqual(shas('@'), []);
  assert.equal(authorLabel(history[0]!.author, ['ada']), 'Ada Lovelace');
  assert.equal(authorLabel(history[0]!.author, []), 'Ada Lovelace');
  assert.equal(authorLabel(undefined, ['ada']), null);
});

test('a detailed history shows the email only where the search found it and not the name', () => {
  const author = { name: 'Ada Lovelace', email: 'ada@example.org' };
  assert.equal(authorLabel(author, ['example']), 'Ada Lovelace <ada@example.org>');
  assert.equal(authorLabel(author, ['ada']), 'Ada Lovelace');
  assert.equal(authorLabel(author, []), 'Ada Lovelace');
});
