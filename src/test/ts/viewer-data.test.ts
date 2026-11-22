import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadViewerData } from '../../main/ts/report/html/app/viewer-data.js';

test('reloading an unavailable detail never mixes it with an earlier summary', async t => {
  const sha = 'a'.repeat(40);
  const oldPath = `inspection/${sha}-${'b'.repeat(64)}.json`;
  const newPath = `inspection/${sha}-${'c'.repeat(64)}.json`;
  const summary = (detail: string) => ({
    schema: 'urn:repometry:schema:repository-summary:1',
    commits: [{ sha, detail, quality: {} }],
  });
  const responses = [
    ['./summary.json', Response.json(summary(oldPath))],
    [`./${oldPath}`, new Response('Not found', { status: 404 })],
    ['./summary.json', Response.json(summary(newPath))],
    [`./${newPath}`, Response.json({ schema: 'urn:repometry:schema:viewer-inspection:1', sha, inspection: {} })],
  ] as const;
  let next = 0;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    const [expected, response] = responses[next++]!;
    assert.equal(path, expected);
    return response;
  });
  const data = await loadViewerData('local');
  await assert.rejects(data.loadDetails(sha), { name: 'ViewerSummaryChanged' });
  assert.equal(next, 3);
});
