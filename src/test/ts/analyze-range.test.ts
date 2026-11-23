import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseRange } from '../../main/ts/cli/revisions.js';

const cli = resolve('target/main/ts/cli/main.js');

function invoke(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, REPOMETRY_DEBUG: '' } });
}

test('a range argument is BASE..HEAD or BASE.., and anything else is a single revision or an error', () => {
  assert.equal(parseRange('HEAD~3'), undefined);
  assert.equal(parseRange('v1.2.3'), undefined);
  assert.deepEqual(parseRange('HEAD~50..HEAD'), { base: 'HEAD~50', head: 'HEAD' });
  assert.deepEqual(parseRange('v1.0.0..main'), { base: 'v1.0.0', head: 'main' });
  assert.deepEqual(parseRange('v1.0.0..'), { base: 'v1.0.0', head: 'HEAD' });
  assert.throws(() => parseRange('..HEAD'), /needs a base/);
  assert.throws(() => parseRange('main...topic'), /symmetric range/);
  assert.throws(() => parseRange('a..b..c'), /one BASE\.\.HEAD range/);
});

test('an unknown revision is one line without git output, unless REPOMETRY_DEBUG is set', async t => {
  const store = await mkdtemp(join(tmpdir(), 'repometry-range-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  for (const revision of ['no-such-revision~3', 'no-such-revision..HEAD']) {
    const result = invoke(['analyze', revision, '--store', store]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `repometry: no-such-revision${revision.endsWith('~3') ? '~3' : ''} is not a commit in ${process.cwd()}\n`);
  }
  const debug = spawnSync(process.execPath, [cli, 'analyze', 'no-such-revision', '--store', store],
    { encoding: 'utf8', env: { ...process.env, REPOMETRY_DEBUG: '1' } });
  assert.equal(debug.status, 1);
  assert.match(debug.stderr, /is not a commit in .*\n.*rev-parse/s);
  assert.deepEqual(await readdir(store), []);
});

test('a range rejects options that describe one checkout, and an empty range succeeds with nothing to do', async t => {
  const store = await mkdtemp(join(tmpdir(), 'repometry-range-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const rejected: [string[], RegExp][] = [
    [['--working-tree'], /Choose a range or --working-tree/],
    [['--import', 'lcov=coverage/lcov.info'], /--import describes one checkout/],
    [['--ci', 'github'], /--ci github needs a single revision/],
  ];
  for (const [options, message] of rejected) {
    const result = invoke(['analyze', 'HEAD..', '--store', store, ...options]);
    assert.equal(result.status, 1, options.join(' '));
    assert.match(result.stderr, message);
  }
  const empty = invoke(['analyze', 'HEAD..HEAD', '--store', store, '--no-config']);
  assert.equal(empty.status, 0, empty.stderr);
  const output = JSON.parse(empty.stdout) as Record<string, unknown>;
  assert.equal(output.schema, 'urn:repometry:schema:analyze-range:1');
  assert.match(String(output.range), /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/);
  for (const key of ['analyzed', 'partial', 'skipped', 'failed', 'reports']) assert.deepEqual(output[key], [], key);
  assert.match(empty.stderr, /No commits in HEAD\.\.HEAD/);
});

test('help for analyze shows the range form and --skip-saved', () => {
  const help = invoke(['help', 'analyze']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: repometry analyze \[REVISION \| BASE\.\.\[HEAD\]\]/);
  assert.match(help.stdout, /--skip-saved/);
});

test('typed paths resolve against the current directory and defaults against the repository root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const sub = join(root, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'index.js'), 'export const one = () => 1;\n');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: sub, encoding: 'utf8' });
  const typed = run(['analyze', '--working-tree', '--store', 'typed-store', '--report', 'json=out/summary.json']);
  assert.equal(typed.status, 0, typed.stderr);
  assert.ok((await readdir(join(sub, 'typed-store'))).length > 0, 'a typed --store lands in the current directory');
  assert.ok((await readdir(join(sub, 'out'))).includes('summary.json'), 'a typed report path lands in the current directory');
  const defaults = run(['analyze', '--working-tree']);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.ok((await readdir(join(root, '.repometry'))).length > 0, 'the default store stays at the repository root');
  const missing = run(['view', '--store', 'no-store', '--port', '0']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, new RegExp(`No saved inspections in ${join(await realpath(sub), 'no-store').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const directory = await realpath(root);
  const rebased = run(['view', '-C', directory, '--store', 'no-store']);
  assert.equal(rebased.status, 1);
  assert.equal(rebased.stderr, `repometry: No saved inspections in ${join(directory, 'no-store')}. Run repometry analyze first.\n`);
});

test('file metrics carry each file size in bytes, and folders sum them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-bytes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const source = 'export const one = () => 1;\n';
  await writeFile(join(root, 'src', 'one.js'), source);
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const analyzed = run(['analyze', '--working-tree']);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const id = (JSON.parse(analyzed.stdout) as { subject: { id: string } }).subject.id;
  const metrics = JSON.parse(run(['show', id, '--files']).stdout) as
    { files: { path: string; bytes?: number }[]; directories: { path: string; bytes?: number }[] };
  assert.equal(metrics.files.find(file => file.path === 'src/one.js')?.bytes, Buffer.byteLength(source));
  assert.equal(metrics.directories.find(folder => folder.path === 'src')?.bytes, Buffer.byteLength(source));
});

test('a revision outside a Git repository is one line, not git output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-nogit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'analyze', 'HEAD'], { cwd: directory, encoding: 'utf8', env: { ...process.env, REPOMETRY_DEBUG: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^repometry: .* is not a Git repository\n$/);
});

test('an inspection records its commit title and author, so a report needs no Git history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-commit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, 'store');
  const analyzed = invoke(['analyze', 'HEAD', '--store', store, '--no-config']);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const title = spawnSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim();
  const author = spawnSync('git', ['log', '-1', '--format=%an'], { encoding: 'utf8' }).stdout.trim();
  const elsewhere = join(directory, 'elsewhere');
  await mkdir(elsewhere);
  const site = join(directory, 'site');
  const exported = spawnSync(process.execPath, [cli, 'report', `html=${site}`, '--store', store], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  const row = (JSON.parse(await readFile(join(site, 'summary.json'), 'utf8')) as { commits: { subject?: string; author?: { name: string; email?: string } }[] }).commits[0]!;
  assert.equal(row.subject, title);
  assert.deepEqual(row.author, { name: author });
});
