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
    [['--concurrency', '0'], /--concurrency must be an integer/],
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
  for (const key of ['analyzed', 'partial', 'skipped', 'failed']) assert.deepEqual(output[key], [], key);
  assert.ok(!Object.hasOwn(output, 'reports'));
  assert.match(empty.stderr, /No commits in HEAD\.\.HEAD/);
});

test('help for analyze shows the range form and --skip-saved', () => {
  const help = invoke(['help', 'analyze']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: repometry analyze \[REVISION \| BASE\.\.\[HEAD\]\]/);
  assert.match(help.stdout, /--skip-saved/);
  assert.match(help.stdout, /--concurrency/);
});

test('analyze rejects the removed CI option and does not advertise it', () => {
  const result = invoke(['analyze', '--ci', 'github']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--ci is not an option of analyze/);
  const help = invoke(['help', 'analyze']);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--ci\b/);
});

test('typed paths resolve against the current directory and defaults against the repository root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const sub = join(root, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'index.js'), 'export const one = () => 1;\n');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: sub, encoding: 'utf8' });
  const typed = run(['analyze', '--working-tree', '--store', 'typed-store']);
  assert.equal(typed.status, 0, typed.stderr);
  assert.ok(!Object.hasOwn(JSON.parse(typed.stdout), 'reports'));
  const config = join(root, 'repometry.config.json');
  await writeFile(config, JSON.stringify({ reports: ['json=out/configured-summary.json'] }));
  const rendered = run(['report', 'json=out/summary.json', '--store', 'typed-store']);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.ok((await readdir(join(sub, 'typed-store'))).length > 0, 'a typed --store lands in the current directory');
  assert.ok((await readdir(join(sub, 'out'))).includes('summary.json'), 'a typed report path lands in the current directory');
  const configuredPath = join(root, 'out', 'configured-summary.json');
  await assert.rejects(readFile(configuredPath), { code: 'ENOENT' });
  const configured = run(['report', '--store', 'typed-store']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(await readFile(configuredPath, 'utf8')).commits, []);
  await assert.rejects(readFile(join(sub, 'out', 'configured-summary.json')), { code: 'ENOENT' });
  const defaults = run(['analyze', '--working-tree']);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.ok((await readdir(join(root, '.repometry'))).length > 0, 'the default store stays at the repository root');
  const missing = run(['view', '--store', 'no-store', '--port', '0']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, new RegExp(`No saved inspections in ${join(await realpath(sub), 'no-store').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const directory = await realpath(root);
  const rebased = run(['view', directory, '--store', join(directory, 'no-store')]);
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
  assert.equal(row.author?.name, author);
});

test('a report shows everything the store holds, and there is no mode to choose', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, 'store');
  assert.equal(invoke(['analyze', 'HEAD', '--store', store, '--no-config']).status, 0);
  const site = join(directory, 'site');
  const result = invoke(['report', `html=${site}`, '--store', store, '--sources', 'none']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readdir(join(site, 'details'))).length > 0, 'per-commit details are written');
  const mode = invoke(['report', `html=${join(directory, 'x')}`, '--store', store, '--mode', 'public']);
  assert.equal(mode.status, 1);
  assert.match(mode.stderr, /--mode is not an option of report/);
});

test('analyze defaults to HEAD and leaves configured rendering to report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-analysis-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json');
  const output = join(directory, 'summary.json');
  const store = join(directory, 'store');
  await writeFile(config, JSON.stringify({ branch: 'report-only-label', reports: ['json=' + output] }));
  const options = ['--config', config, '--store', store];
  const result = invoke(['analyze', ...options]);
  assert.equal(result.status, 0, result.stderr);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.subject.id, head.stdout.trim());
  assert.ok(!Object.hasOwn(summary, 'reports'));
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  const rendered = invoke(['report', ...options]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.source.branch, 'report-only-label');
  assert.equal(report.commits[0].sha, summary.subject.id);
});
