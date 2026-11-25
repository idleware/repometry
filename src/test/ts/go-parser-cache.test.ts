import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { cachedGoParser } from '../../main/ts/api/process/go-parser-cache.js';

const run = promisify(execFile);

test('concurrent processes compile one parser for a cache key and recover a damaged binary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'cache');
  const log = join(root, 'builds');
  const helper = new URL('../../main/ts/api/process/go-parser-cache.js', import.meta.url);
  const script = `
    import { appendFile, writeFile } from 'node:fs/promises';
    import { join, resolve } from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    import { cachedGoParser } from ${JSON.stringify(helper.href)};
    const [key, file, log] = process.argv.slice(1);
    const executable = await cachedGoParser(key, performance.now() + 10_000, async () => {
      await appendFile(log, 'build\\n');
      await setTimeout(100);
      await writeFile(file, 'parser bytes', { mode: 0o700 });
      return file;
    });
    process.stdout.write(executable);
  `;
  const spawn = (key: string, name: string) => run(process.execPath, ['--input-type=module', '-e', script, key, join(root, name), log],
    { env: { ...process.env, REPOMETRY_CACHE_DIR: cache } }).then(({ stdout }) => stdout);
  const key = 'a'.repeat(64);
  const [first, second] = await Promise.all([spawn(key, 'first'), spawn(key, 'second')]);
  assert.equal(first, second);
  assert.equal(await readFile(log, 'utf8'), 'build\n');
  assert.equal(await spawn(key, 'third'), first);
  assert.equal(await readFile(log, 'utf8'), 'build\n');

  await rm(first);
  await writeFile(first, 'broken parser', { mode: 0o500 });
  assert.equal(await spawn(key, 'rebuild'), first);
  assert.equal(await readFile(first, 'utf8'), 'parser bytes');
  assert.equal(await readFile(log, 'utf8'), 'build\nbuild\n');
  assert.notEqual(await spawn('b'.repeat(64), 'new-key'), first);
  assert.equal(await readFile(log, 'utf8'), 'build\nbuild\nbuild\n');
});

test('an unavailable cache reports its path without building a process-local parser', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cache-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = join(root, 'file');
  await writeFile(occupied, '');
  await assert.rejects(cachedGoParser('a'.repeat(64), performance.now() + 1000,
    async () => assert.fail('cache setup must succeed before compilation'), occupied),
  { message: /Go parser cache .*go-parsers-v1/ });
});

test('cache clear removes Go parsers and source blobs, with an option to keep parsers', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'repometry-clear-cache-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const parsers = join(cache, 'go-parsers-v1');
  const sources = join(cache, 'sources');
  await Promise.all([mkdir(parsers), mkdir(sources)]);
  const clear = async (...options: string[]) => {
    const { stdout } = await run(process.execPath, [resolve('target/main/ts/cli/main.js'), 'cache', 'clear', ...options],
      { env: { ...process.env, REPOMETRY_CACHE_DIR: cache } });
    return JSON.parse(stdout).cleared as string[];
  };
  assert.deepEqual(await clear('--sources'), ['sources']);
  await access(parsers);
  await assert.rejects(access(sources), { code: 'ENOENT' });
  await mkdir(sources);
  assert.deepEqual(await clear(), ['sources', 'go-parsers-v1']);
  await assert.rejects(access(sources), { code: 'ENOENT' });
  await assert.rejects(access(parsers), { code: 'ENOENT' });
});
