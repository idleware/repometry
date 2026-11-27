import assert from 'node:assert/strict';
import { test } from 'node:test';
import { churnSettings, summarizeGitHistory } from '../../main/ts/api/git/git-churn.js';

const head = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const root = 'c'.repeat(40);
const renamed = 'folder/name\npart.js';
const withLeadingLineBreak = '\nfirst.js';

function record(id: string, date: number, previous: string, paths: readonly string[]): string {
  const suffix = paths.length ? `\n${paths.join('\0')}\0` : '';
  return `\0${id} ${date} ${previous}\0${suffix}`;
}

test('churn counts unique path touches in the commit-relative window and skips root snapshots', () => {
  const now = 1794324738;
  const log = [
    record(head, now, parent, [withLeadingLineBreak, renamed, renamed]),
    record(parent, now - 60, root, [renamed, 'deleted.js']),
    record(root, now - 120, '', [withLeadingLineBreak]),
  ].join('');
  const result = summarizeGitHistory(log, head, [renamed, withLeadingLineBreak, 'zero.js'], false);
  assert.deepEqual(Object.fromEntries(result.touches), { [renamed]: 2, [withLeadingLineBreak]: 1, 'zero.js': 0 });
  assert.deepEqual(result.window, { endingAt: '2026-11-10T15:32:18.000Z', commits: 2, shallow: false, capReached: false });
});

test('older or truncated history and a shallow root do not inflate counts', () => {
  const now = 1794324738;
  const old = now - churnSettings.lookbackDays * 86400 - 1;
  const log = record(head, now, parent, ['head.js']) + record(parent, old, root, ['head.js']);
  assert.equal(summarizeGitHistory(log, head, ['head.js'], false).touches.get('head.js'), 1);
  assert.equal(summarizeGitHistory(record(head, now, '', ['head.js']), head, ['head.js'], true).touches.size, 0);

  const historic = Array.from({ length: churnSettings.maxCommits }, (_, index) => record(index.toString(16).padStart(40, '0'),
    now - 60, parent, ['head.js'])).join('');
  const result = summarizeGitHistory(record(head, now, parent, ['head.js']) + historic, head, ['head.js'], false);
  assert.equal(result.touches.get('head.js'), churnSettings.maxCommits);
  assert.equal(result.window.capReached, true);
});
