import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const cli = resolve('target/main/ts/cli/main.js');
const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A repository whose `main` holds the files, checked out on a new `feature` branch. */
async function project(t: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repometry-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  await write(root, files);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  git(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

async function change(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await write(root, files);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'change']);
}

function review(root: string, args: readonly string[] = ['main'], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, 'review', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  const parsed = result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) as {
    number: number | null; issues: { effect: string; before: number | null; finding: { anchor?: string } }[]; notes: { message: string }[];
  } : undefined;
  return { ...result, review: parsed };
}

function branchy(name: string, count: number, body = 'total++'): string {
  const steps = Array.from({ length: count }, (_, index) => `  if (v === ${index}) ${body};`);
  return [`export function ${name}(v) {`, '  let total = 0;', ...steps, '  return total;', '}', ''].join('\n');
}

test('raising a function\'s complexity from 17 to 19 fails with one worsened issue', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 17) });
  await change(root, { 'src/run.js': branchy('run', 19) });
  const result = review(root);
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(result.review?.issues.map(issue => [issue.effect, issue.before, issue.finding.anchor]), [['worsened', 17, 'run']]);
});

test('editing a line inside an already complex function is touched only', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 31) });
  await change(root, { 'src/run.js': branchy('run', 31).replace('if (v === 5) total++;', 'if (v === 5) total += 1;') });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.issues.map(issue => issue.effect), ['touched']);
});

test('renaming a file and moving a function within a file add no new issues', async t => {
  const small = 'export function small() {\n  return 1;\n}\n';
  const root = await project(t, { 'src/run.js': branchy('run', 31), 'src/pair.js': `${branchy('big', 31)}${small}` });
  git(root, ['mv', 'src/run.js', 'src/main.js']);
  await change(root, { 'src/pair.js': `${small}${branchy('big', 31)}` });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.issues.filter(issue => issue.effect === 'new'), []);
});

test('editing the settings adds a note', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 3), 'repometry.config.json': '{ "exclude": [] }\n' });
  await change(root, { 'repometry.config.json': '{ "exclude": ["docs/**"] }\n' });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.notes.map(note => note.message),
    ['This change edits Repometry settings, which can hide issues from this check.']);
});

test('review leaves the store alone and needs no saved inspection', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 3) });
  await change(root, { 'src/run.js': branchy('run', 4) });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(await readdir(root)).includes('.repometry'), 'no store is written');
});

test('a change with no commits of its own passes', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 31) });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.issues, []);
});

test('a checkout without the base history explains how to fetch it', async t => {
  const origin = await project(t, { 'src/run.js': branchy('run', 3) });
  await change(origin, { 'src/run.js': branchy('run', 4) });
  git(origin, ['checkout', '-q', 'main']);
  await change(origin, { 'README.md': 'main moved on\n' });
  const shallow = await mkdtemp(join(tmpdir(), 'repometry-shallow-'));
  t.after(() => rm(shallow, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${origin}`, shallow]).status, 0);
  git(shallow, ['fetch', '-q', '--depth', '1', 'origin', 'main:main']);
  const result = review(shallow);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetch-depth: 0/);
});

test('scanner imports and removed options are refused', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 3) });
  const sarif = review(root, ['main', '--import', 'sarif=results.sarif']);
  assert.equal(sarif.status, 1);
  assert.match(sarif.stderr, /review compares both sides of a change; scanner imports apply to full inspections only/);
  for (const option of [['--max-coverage-drop', '1'], ['--baseline-store', '.']]) {
    const refused = review(root, ['main', ...option]);
    assert.equal(refused.status, 1, option[0]);
    assert.match(refused.stderr, new RegExp(option[0]!.slice(2)));
  }
});

test('under --ci github the pull request number comes from the event', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 3) });
  await change(root, { 'src/run.js': branchy('run', 4) });
  const files = await mkdtemp(join(tmpdir(), 'repometry-github-'));
  t.after(() => rm(files, { recursive: true, force: true }));
  const [event, outputs, summary] = ['event.json', 'outputs', 'summary'].map(name => join(files, name));
  await writeFile(event!, JSON.stringify({ pull_request: { number: 42 } }));
  const result = review(root, ['main', '--ci', 'github'],
    { GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.review?.number, 42);
});

function route(path: string, count: number): string {
  const steps = Array.from({ length: count }, (_, index) => `  if (v === ${index}) total++;`);
  return [`app.get('${path}', v => {`, '  let total = 0;', ...steps, '  return total;', '});', ''].join('\n');
}

test('simplifying one of several unnamed handlers improves it and leaves the others alone', async t => {
  const root = await project(t, { 'src/routes.js': `${route('/a', 20)}${route('/b', 25)}` });
  await change(root, { 'src/routes.js': `${route('/a', 10)}${route('/b', 25)}` });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.issues.map(issue => [issue.effect, issue.before]), [['improved', 20]]);
});

test('renaming a complex function keeps its issue', async t => {
  const root = await project(t, { 'src/run.js': branchy('run', 31) });
  await change(root, { 'src/run.js': branchy('execute', 31) });
  const result = review(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.review?.issues.map(issue => [issue.effect, issue.finding.anchor]), [['touched', 'execute']]);
});

test('a default shallow checkout without the base branch explains how to fetch it', async t => {
  const origin = await project(t, { 'src/run.js': branchy('run', 3) });
  await change(origin, { 'src/run.js': branchy('run', 4) });
  const shallow = await mkdtemp(join(tmpdir(), 'repometry-shallow-'));
  t.after(() => rm(shallow, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${origin}`, shallow]).status, 0);
  const result = review(shallow, ['origin/main']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /origin\/main.*fetch-depth: 0/s);
});
