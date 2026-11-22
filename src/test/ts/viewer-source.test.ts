import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandLocator, loadSource, sourceLocator, sourcePage, useSources } from '../../main/ts/report/html/app/viewer-source.js';

const revision = 'a'.repeat(40);
const github = {
  provider: 'github',
  url: 'https://raw.githubusercontent.com/semrel-extra/zx-semrel/{revision}/{path}',
  web: 'https://github.com/semrel-extra/zx-semrel/blob/{revision}/{path}#L{line}',
};
const gitlab = {
  provider: 'gitlab',
  url: 'https://gitlab.com/api/v4/projects/group%2Fproject/repository/files/{path:component}/raw?ref={revision}',
  web: 'https://gitlab.com/group/project/-/blob/{revision}/{path}#L{line}',
};

test('a GitHub locator keeps the path’s slashes and encodes each segment', () => {
  assert.equal(expandLocator(github.url, { revision, path: 'src/main/js/a b#c%.js' }),
    `https://raw.githubusercontent.com/semrel-extra/zx-semrel/${revision}/src/main/js/a%20b%23c%25.js`);
  assert.equal(expandLocator(github.web, { revision, path: 'src/index.ts', line: 42 }),
    `https://github.com/semrel-extra/zx-semrel/blob/${revision}/src/index.ts#L42`);
});

test('a GitLab locator encodes the whole path as one component, as its files API wants', () => {
  assert.equal(expandLocator(gitlab.url, { revision, path: 'src/sub dir/ü.ts' }),
    `https://gitlab.com/api/v4/projects/group%2Fproject/repository/files/src%2Fsub%20dir%2F%C3%BC.ts/raw?ref=${revision}`);
});

test('a page link without a line opens the file, not an empty anchor', () => {
  assert.equal(expandLocator(gitlab.web, { revision, path: 'README.md' }), `https://gitlab.com/group/project/-/blob/${revision}/README.md`);
});

test('a local locator stays relative to the site', () => {
  assert.equal(expandLocator('./sources/{revision}/{path}', { revision, path: '.github/workflows/ci.yml' }),
    `./sources/${revision}/.github/workflows/ci.yml`);
});

test('only usable locators pass: a fetch URL over http(s) or the site, a page link only over http(s)', () => {
  assert.deepEqual(sourceLocator(github), github);
  assert.deepEqual(sourceLocator({ provider: 'local', url: './sources/{revision}/{path}' }), { provider: 'local', url: './sources/{revision}/{path}' });
  assert.deepEqual(sourceLocator({ ...github, web: 'javascript:alert(1)//{path}' }), { provider: 'github', url: github.url });
  assert.equal(sourceLocator({ provider: 'x', url: 'javascript:fetch("{path}")' }), undefined);
  assert.equal(sourceLocator({ provider: 'x', url: 'https://example.com/raw' }), undefined);
  assert.equal(sourceLocator(undefined), undefined);
  assert.equal(sourceLocator('https://example.com/{path}'), undefined);
});

test('sources are fetched once per URL, only when asked, and anything but a success reads as not available', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    if (url.endsWith('/gone.ts')) return new Response('Not found', { status: 404 });
    if (url.endsWith('/offline.ts')) throw new TypeError('Failed to fetch');
    return new Response(`text of ${url.slice(url.lastIndexOf('/') + 1)}`);
  });
  useSources(undefined);
  assert.equal(await loadSource(revision, 'src/a.ts'), null);
  assert.equal(sourcePage(revision, 'src/a.ts', 3), null);
  assert.equal(calls.length, 0);

  useSources(github);
  assert.equal(calls.length, 0);
  assert.equal(await loadSource(revision, 'src/a.ts'), 'text of a.ts');
  assert.equal(await loadSource(revision, 'src/a.ts'), 'text of a.ts');
  assert.equal(await loadSource(revision, 'src/gone.ts'), null);
  assert.equal(await loadSource(revision, 'src/offline.ts'), null);
  assert.equal(calls.length, 3);
  assert.deepEqual(sourcePage(revision, 'src/a.ts', 3), { href: `https://github.com/semrel-extra/zx-semrel/blob/${revision}/src/a.ts#L3`, provider: 'GitHub' });
  useSources({ provider: 'forgejo', url: github.url, web: github.web });
  assert.equal(sourcePage(revision, 'src/a.ts')?.provider, 'Forgejo');
  useSources(undefined);
});
