import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { siteSummary } from '../../main/ts/report/html/site/export-site.js';
import { validateSummary } from '../../main/ts/report/json/validation/summary-validation.js';
import { resolveSourceLocator } from '../../main/ts/compose/sources.js';
import { clearCaches } from '../../main/ts/api/cache/root.js';
import { cachedBlob } from '../../main/ts/api/git/source-cache.js';
import { sourceResponse } from '../../main/ts/report/html/site/source-route.js';
import { serveAssets } from '../../main/ts/report/html/site/server.js';


test('source locators are a valid part of every summary', () => {
  const sources = { provider: 'local', url: './sources/{revision}/{path}' };
  for (const mode of ['local', 'private'] as const) {
    const options = { mode, sources };
    const summary: unknown = JSON.parse(siteSummary([], options).toString('utf8'));
    assert.ok(validateSummary(summary));
    assert.deepEqual((summary as { sources?: unknown }).sources, sources);
  }
});

test('auto selects CI before remotes and explicit providers resolve subgroup and enterprise URLs', () => {
  const github = resolveSourceLocator('auto', { env: {}, remotes: ['git@github.com:semrel-extra/zx-semrel.git'] });
  assert.deepEqual(github, {
    provider: 'github', url: 'https://raw.githubusercontent.com/semrel-extra/zx-semrel/{revision}/{path}',
    web: 'https://github.com/semrel-extra/zx-semrel/blob/{revision}/{path}#L{line}',
  });
  const gitlab = resolveSourceLocator('auto', {
    env: { CI_PROJECT_PATH: 'group/sub/project', CI_SERVER_URL: 'https://gitlab.example' },
    remotes: ['https://github.com/semrel-extra/zx-semrel.git'],
  });
  assert.equal(gitlab?.url, 'https://gitlab.example/api/v4/projects/group%2Fsub%2Fproject/repository/files/{path:component}/raw?ref={revision}');
  const enterprise = resolveSourceLocator('github', {
    env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.example' }, remotes: [],
  });
  assert.equal(enterprise?.url, 'https://github.example/owner/repo/raw/{revision}/{path}');
  assert.equal(resolveSourceLocator('none', { env: {}, remotes: ['git@github.com:owner/repo.git'] }), undefined);
  assert.equal(resolveSourceLocator('auto', { env: {}, remotes: ['/tmp/local-repo'] })?.provider, 'local');
});

test('source requests read only listed paths at a full report revision', async () => {
  const sha = 'a'.repeat(40);
  const path = 'src/with spaces.ts';
  const bytes = Buffer.from('export const n = 3;');
  let reads = 0;
  const access = { async read() { reads++; return bytes; } };
  const listed = async (revision: string, requested: string) => revision === sha && requested === path;
  assert.deepEqual(await sourceResponse(`sources/${sha}/src/with%20spaces.ts`, access, listed), bytes);
  assert.equal(await sourceResponse(`sources/${sha}/README.md`, access, listed), undefined);
  assert.equal(await sourceResponse('sources/a/src/with%20spaces.ts', access, listed), undefined);
  assert.equal(await sourceResponse(`sources/${sha}/src/bad%0Aname.ts`, access, async () => true), undefined);
  assert.equal(reads, 1);
});

test('the viewer accepts loopback host aliases and rejects unrelated hosts', async t => {
  const site = await serveAssets(0, async () => Buffer.from('report'));
  t.after(site.close);
  const { port } = new URL(site.url);
  async function status(host: string) {
    return new Promise<number | undefined>((resolve, reject) => {
      get(site.url, { headers: { host } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
  }
  assert.equal(await status(`127.0.0.1:${port}`), 200);
  assert.equal(await status(`localhost:${port}`), 200);
  assert.equal(await status(`[::1]:${port}`), 200);
  assert.equal(await status(`other.example:${port}`), 403);
  assert.equal(await status(`localhost:${Number(port) + 1}`), 403);
});

test('the blob cache reuses a Git object and clearing it empties only the source cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-source-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('export const n = 3;');
  const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  let loads = 0;
  const load = async () => { loads++; return bytes; };
  assert.deepEqual(await cachedBlob(root, oid, load), bytes);
  assert.deepEqual(await cachedBlob(root, oid, load), bytes);
  assert.deepEqual(await readFile(join(root, 'sources', oid.slice(0, 2), oid)), bytes);
  assert.equal(loads, 1);
  await clearCaches(root, true);
  assert.deepEqual(await cachedBlob(root, oid, load), bytes);
  assert.equal(loads, 2);
});
