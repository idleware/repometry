import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishPullCoverageComment } from '../../main/ts/api/gh/github-pr-comment.js';

const repository = 'owner/project';
const head = '1'.repeat(40);
const base = '2'.repeat(40);
const marker = '<!-- repometry-coverage:v1 -->';
const env = {
  GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: repository, GITHUB_API_URL: 'https://gh.example.test/api/v3',
  REPOMETRY_COMMENT_TOKEN: 'fixture-token', REPOMETRY_PR_REPOSITORY: repository, REPOMETRY_PR_NUMBER: '12',
  REPOMETRY_PR_HEAD: head, REPOMETRY_PR_BASE: base, REPOMETRY_REVIEW_HEAD: head, REPOMETRY_REVIEW_BASE: base,
  REPOMETRY_DIFF_STATUS: 'partial', REPOMETRY_DIFF_PERCENT: '50', REPOMETRY_DIFF_TOTAL: '4', REPOMETRY_DIFF_COVERED: '2',
  REPOMETRY_TOTAL_PERCENT: '95.42', REPOMETRY_TOTAL_DELTA: '-0.33', REPOMETRY_TOTAL_GATE: 'passed',
  REPOMETRY_DIFF_GATE: 'malicious-text', REPOMETRY_POTENTIALLY_PRIVATE_FILENAME: 'private-folder/file.ts',
};
const ref = (sha: string) => ({ sha, repo: { full_name: repository } });

test('PR coverage comments are upserted with aggregate-only output and bot ownership', async () => {
  const comment = { id: 88, body: marker + '\nuser-authored comment', user: { login: 'member', type: 'User' } };
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const saved = [comment];
  const writes: string[] = [];
  const request: typeof fetch = async (request, options) => {
    const url = new URL(String(request));
    const method = options?.method;
    assert.equal(url.origin, 'https://gh.example.test');
    assert.ok(url.pathname.startsWith('/api/v3/repos/owner/project/'));
    assert.equal(options?.redirect, 'error');
    if (url.pathname.endsWith('/pulls/12')) return Response.json({ state: 'open', head: ref(head), base: ref(base) });
    if (method === 'GET') {
      assert.ok(url.pathname.endsWith('/issues/12/comments'));
      return Response.json(saved);
    }
    const body = JSON.parse(String(options?.body)).body as string;
    assert.ok(body.startsWith(marker));
    assert.match(body, /50.00% · 2\/4 measured lines · Partial/);
    assert.doesNotMatch(body, /private-folder|malicious-text|fixture-token/);
    if (method === 'POST') {
      assert.ok(url.pathname.endsWith('/issues/12/comments'));
      saved.push({ id: 99, body, user: bot });
    } else {
      assert.equal(method, 'PATCH');
      assert.ok(url.pathname.endsWith('/issues/comments/99'));
      saved[1]!.body = body;
    }
    writes.push(method);
    return Response.json({});
  };
  assert.equal(await publishPullCoverageComment(env, request), 'created');
  assert.equal(await publishPullCoverageComment(env, request), 'unchanged');
  assert.equal(await publishPullCoverageComment({ ...env, REPOMETRY_TOTAL_PERCENT: '94.72' }, request), 'updated');
  assert.deepEqual(writes, ['POST', 'PATCH']);
  assert.equal(saved[0]?.body, marker + '\nuser-authored comment');
});

test('fork, target events and stale revisions cannot send PR comments', async () => {
  const guarded: typeof fetch = async () => { throw new Error('Unexpected network call'); };
  assert.equal(await publishPullCoverageComment({ ...env, REPOMETRY_PR_REPOSITORY: 'fork/project' }, guarded), 'skipped');
  assert.equal(await publishPullCoverageComment({ ...env, GITHUB_EVENT_NAME: 'pull_request_target' }, guarded), 'skipped');
  assert.equal(await publishPullCoverageComment({ ...env, REPOMETRY_REVIEW_HEAD: base }, guarded), 'skipped');
  const stale: typeof fetch = async (request, options) => {
    assert.equal(options?.method, 'GET');
    assert.ok(String(request).endsWith('/pulls/12'));
    return Response.json({ state: 'open', head: ref('3'.repeat(40)), base: ref(base) });
  };
  assert.equal(await publishPullCoverageComment(env, stale), 'skipped');
});
