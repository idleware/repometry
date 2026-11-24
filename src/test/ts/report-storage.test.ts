import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { definitions } from '../../main/ts/core/model/measurement.js';
import { GitReportReader } from '../../main/ts/api/git/git-reader.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';
import { ObjectError, objectPath } from '../../main/ts/report/json/store/report-tree.js';
import { metaManifest } from '../../main/ts/report/json/validation/metabranch.js';
import { checkStore } from '../../main/ts/report/json/store/store-check.js';
import { reportSchema } from '../../main/ts/report/json/validation/report.js';
import { packJson } from '../../main/ts/report/json/wire/compact-json.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';

function report(char: string, committedAt: string, lines: number): Report {
  return {
    schema: reportSchema, subject: { kind: 'commit', id: char.repeat(40) },
    generatedAt: '2026-11-21T09:00:00.000Z',
    committedAt,
    appliedConfig: { profile: 'fixture' },
    definitions: { [definitions.lines]: 'Physical lines' },
    status: 'complete', scope: { files: 1, parsed: 1 },
    measurements: [{ definition: definitions.lines, target: 'file', path: 'src/nested/component.ts', value: lines }],
    diagnostics: [],
  };
}

function detailed(char: string, lines: number): Report {
  const base = report(char, '2026-01-01T00:00:00.000Z', lines);
  const path = 'src/nested/component.ts';
  return {
    ...base,
    appliedConfig: { profile: 'fixture', churnWindow: { endingAt: base.committedAt, commits: lines }, coverage: null },
    definitions: { ...base.definitions, [definitions.complexity]: 'Cyclomatic complexity' },
    measurements: [
      ...base.measurements,
      { definition: definitions.lines, target: 'file', path: 'README.md', value: 3 },
      { definition: definitions.complexity, target: 'function', path, line: 2, column: 1, name: 'render', value: 4 },
      { definition: definitions.lines, target: 'repository', value: lines + 3 },
      { definition: definitions.lines, target: 'file', path: 'src/nested/component.ts.map', value: 1 },
    ],
    findings: [
      { tool: 'lint', rule: 'structure', category: 'lint', level: 'low', path, line: 1, message: 'Keep detail', related: [{ path, line: 2, endLine: 5 }] },
      { tool: 'lint', rule: 'setup', category: 'lint', level: 'unknown', message: 'Repository-wide' },
    ],
    ruleSkips: [{ path: 'README.md', plugin: 'lint', rules: ['structure'], reason: 'unmeasured' }],
    pluginData: {
      metrics: [], measured: [], rules: [],
      products: {
        'repometry.lcov-lines/v1': [{ operation: 'lcov/lines', value: { [path]: { covered: [[1, 2]], uncovered: [] } } }],
        'fixture.per-file/v1': [{ operation: 'fixture', path, value: { tokens: lines } }],
      },
      inventory: [
        { path: 'README.md', lines: 3, language: 'markdown', analysed: false },
        { path, lines, bytes: lines * 10, language: 'typescript', analysed: true },
        { path: 'src/nested/component.ts.map', lines: 1, language: 'json', analysed: false },
      ],
    },
  };
}

async function objectCount(store: string): Promise<number> {
  return (await new LocalReportStore(store).objects.ids()).length;
}

test('stored reports keep file rows in shared objects and read back exactly', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-storage-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const original = detailed('a', 20);
  await store.save(original);
  const saved = await readFile(join(output, 'commits', original.subject.id, 'report.json'), 'utf8');
  assert.ok(!saved.includes('"render"') && !saved.includes('Keep detail') && !saved.includes('tokens'), 'file rows live in objects');
  assert.equal(saved.split('src/nested/component.ts').length - 1, 1, 'line coverage stays one product per commit');
  assert.equal(JSON.stringify(await store.read(original.subject)), JSON.stringify(original));
  assert.deepEqual(await store.read(original.subject), original);

  // The next commit changes one file: only that file's rows and its directory are new objects.
  const before = await objectCount(output);
  const next: Report = { ...original, subject: { kind: 'commit', id: 'b'.repeat(40) },
    measurements: original.measurements.map(row => row.path === 'README.md' ? { ...row, value: 4 } : row) };
  await store.save(next);
  assert.equal(await objectCount(output) - before, 2);
  assert.equal(JSON.stringify(await store.read(next.subject)), JSON.stringify(next));
  assert.deepEqual((await store.list()).map(item => item.subject.id).sort(), ['a'.repeat(40), 'b'.repeat(40)]);
});

test('stored reports reject an edit that moves rows between files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-storage-revision-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const original = report('a', '2026-01-01T00:00:00.000Z', 20);
  const first = original.measurements[0]!;
  const second = { ...first, path: 'src/other.ts', value: 7 };
  await store.save({ ...original, measurements: [first, second] });
  const file = join(output, 'commits', original.subject.id, 'report.json');
  const text = await readFile(file, 'utf8');
  assert.match(text, /"measurements":\[\[0,2\]\]/);
  await writeFile(file, text.replace('"measurements":[[0,2]]', '"measurements":[[1,1],[0,1]]'));
  await assert.rejects(store.read(original.subject), /Report revision mismatch/);
});

test('store check finds missing and corrupt objects and repairs them from a copy or a new save', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-store-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'store');
  const copy = join(directory, 'copy');
  const store = new LocalReportStore(output);
  const original = detailed('a', 20);
  await store.save(original);
  await store.save({ ...original, subject: { kind: 'commit', id: 'b'.repeat(40) } });
  await new LocalReportStore(copy).save(original);
  assert.deepEqual((await checkStore(output)).problems, []);

  const stored = JSON.parse(await readFile(join(output, 'commits', original.subject.id, 'report.json'), 'utf8'));
  const tree = join(output, objectPath(stored.tree));
  await rm(tree);
  await writeFile(join(output, objectPath(stored.profile)), 'not JSON');
  await assert.rejects(store.read(original.subject), (error: unknown) => error instanceof ObjectError);
  const damaged = await checkStore(output);
  assert.deepEqual(damaged.problems.map(item => item.problem).sort(), ['missing-objects', 'missing-objects']);
  assert.ok(damaged.problems.every(item => item.objects?.includes(stored.tree) && item.objects.includes(stored.profile)));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const id of await store.objects.ids()) await utimes(join(output, objectPath(id)), old, old);
  assert.equal((await checkStore(output, {})).repaired?.removed, 0, 'objects under a missing directory stay');

  const repaired = await checkStore(output, { from: new LocalReportStore(copy).objects.source() });
  assert.equal(repaired.repaired?.restored, 2);
  assert.deepEqual(repaired.problems, []);
  assert.equal(JSON.stringify(await store.read(original.subject)), JSON.stringify(original));

  // Saving the same report again restores what it references, as `repometry analyze` does.
  await rm(tree);
  await store.save(original);
  assert.deepEqual((await checkStore(output)).problems, []);
});

test('single-file reports stay valid next to reports with objects, and repair removes old unreferenced objects', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-store-mixed-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const older = detailed('a', 20);
  const single = join(output, 'commits', older.subject.id, 'report.json');
  const { schema, strings, shapes, data } = packJson(older);
  const text = `{"schema":"${schema}","summary":${JSON.stringify(commitSummary(older))},\n${JSON.stringify({ strings, shapes, data }).slice(1)}\n`;
  await mkdir(dirname(single), { recursive: true });
  await writeFile(single, text);
  const newer = { ...detailed('b', 21), committedAt: '2026-02-01T00:00:00.000Z' };
  await store.save(newer);
  assert.deepEqual(await store.read(older.subject), older);
  assert.deepEqual(await store.read(newer.subject), newer);
  assert.deepEqual((await store.listSummaries()).map(row => row.sha), [newer.subject.id, older.subject.id]);
  const mixed = await checkStore(output);
  assert.deepEqual(mixed.problems, []);
  assert.equal(mixed.summary, 'current');

  await store.save({ ...newer, measurements: [{ ...newer.measurements[0]!, value: 22 }] });
  const unused = await checkStore(output);
  assert.ok(unused.unreferenced > 0);
  assert.equal((await checkStore(output, {})).repaired?.removed, 0, 'recent objects may belong to a save in progress');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const id of await store.objects.ids()) await utimes(join(output, objectPath(id)), old, old);
  assert.equal((await checkStore(output, {})).repaired?.removed, unused.unreferenced);
  assert.deepEqual((await checkStore(output)).problems, []);
  assert.equal(await readFile(single, 'utf8'), text, 'a single-file report is never rewritten');
});

test('a storage branch reads straight from Git, with or without its summary.json', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-storage-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalReportStore(directory);
  const older = detailed('a', 20);
  const newer = { ...detailed('b', 21), committedAt: '2026-02-01T00:00:00.000Z' };
  await store.save(older);
  await store.save(newer);
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(metaManifest)}\n`);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  const tree = git('write-tree');
  const reader = new GitReportReader(directory, tree);
  assert.deepEqual(await reader.read(older.subject), older);
  assert.deepEqual(await reader.list(), await store.list());
  const rows = (await store.listSummaries()).map(({ sha, revision }) => [sha, revision]);
  assert.deepEqual((await reader.listSummaries()).map(({ sha, revision }) => [sha, revision]), rows);
  await assert.rejects(reader.read({ kind: 'commit', id: 'c'.repeat(40) }), { code: 'ENOENT' });
  await assert.rejects(new GitReportReader(directory, 'no-such-branch').listSummaries(), /no-such-branch is not a commit or tree/);

  // A branch without summary.json lists history from each report's first line.
  git('rm', '--cached', '-q', 'summary.json');
  const withoutSummary = new GitReportReader(directory, git('write-tree'));
  assert.deepEqual((await withoutSummary.listSummaries()).map(({ sha, revision }) => [sha, revision]), rows);

  const stored = JSON.parse(await readFile(join(directory, 'commits', older.subject.id, 'report.json'), 'utf8'));
  git('rm', '--cached', '-q', objectPath(stored.tree));
  await assert.rejects(new GitReportReader(directory, git('write-tree')).read(older.subject), (error: unknown) => error instanceof ObjectError);
});

test('summary includes current uncompressed reports and reinspection updates the old point in place', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-summary-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const older = report('a', '2026-01-01T00:00:00.000Z', 12);
  const newer = report('b', '2026-02-01T00:00:00.000Z', 19);
  const third = report('c', '2026-03-01T00:00:00.000Z', 30);
  const legacy = join(output, 'commits', older.subject.id);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'report.json'), JSON.stringify(older, null, 2));
  const history = async () => JSON.parse(await readFile(join(output, 'summary.json'), 'utf8')).commits
    .map(({ sha, lines }: { sha: string; lines: number }) => [sha[0], lines]);
  await Promise.all([store.save(newer), new LocalReportStore(output).save(third)]);
  assert.deepEqual(await history(), [['c', 30], ['b', 19], ['a', 12]]);
  await store.save({ ...older, generatedAt: '2026-11-22T09:00:00.000Z',
    measurements: [{ ...older.measurements[0]!, value: 13 }] });
  assert.deepEqual(await history(), [['c', 30], ['b', 19], ['a', 13]]);
  await store.save({ ...newer, subject: { kind: 'working-tree', id: 'd'.repeat(64) } });
  assert.deepEqual(await history(), [['c', 30], ['b', 19], ['a', 13]]);
  const empty = report('e', '2026-01-01T00:00:00.000Z', 0);
  await store.save({ ...empty, committedAt: '2025-01-01T00:00:00.000Z', appliedConfig: { profile: 'js-ts/v1' },
    generatedAt: '2026-11-22T09:00:00.000Z', scope: { files: 0, parsed: 0 }, measurements: [], status: 'not-applicable' });
  assert.deepEqual(await history(), [['c', 30], ['b', 19], ['a', 13], ['e', null]]);
});

test('summary does not read a symlink to another report store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-summary-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'original');
  const target = join(directory, 'other');
  await new LocalReportStore(source).save(report('a', '2026-01-01T00:00:00.000Z', 20));
  await mkdir(target);
  await symlink(join(source, 'commits'), join(target, 'commits'));
  await assert.rejects(new LocalReportStore(target).listSummaries(), /Expected a directory/);
});

test('a legacy timestamp or inconsistent duplication counts do not prevent other reports from being indexed', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-summary-compat-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const older = report('a', '2026-01-01T00:00:00.000Z', 5);
  const legacy: Report = {
    ...older, generatedAt: 'unknown',
    definitions: { ...older.definitions, [definitions.codeLines]: 'Code lines', [definitions.duplicatedLines]: 'Duplicated lines' },
    measurements: [...older.measurements,
      { ...older.measurements[0]!, definition: definitions.codeLines },
      { ...older.measurements[0]!, definition: definitions.duplicatedLines, value: 6 }],
  };
  await store.save(legacy);
  await store.save(report('b', '2026-02-01T00:00:00.000Z', 9));
  const summaries = await store.listSummaries();
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1]?.quality.duplication?.ratio, null);
  assert.deepEqual(await store.read(legacy.subject), legacy);
});

test('older cached zero grades are recalculated from the saved inspection', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-summary-grade-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const base = report('a', '2026-01-01T00:00:00.000Z', 5);
  const original = { ...base, findings: [],
    definitions: { ...base.definitions, [definitions.codeLines]: 'Code lines' },
    measurements: [...base.measurements, { ...base.measurements[0]!, definition: definitions.codeLines }] };
  await store.save(original);
  const path = join(output, 'commits', base.subject.id, 'report.json');
  const [header, ...body] = (await readFile(path, 'utf8')).split('\n');
  const envelope = JSON.parse(header!.slice(0, -1) + '}');
  envelope.summary.quality.maintainability = { smells: 0, effortMinutes: 0, debtRatio: null, grade: null };
  await writeFile(path, [JSON.stringify(envelope).slice(0, -1) + ',', ...body].join('\n'));
  assert.equal((await store.listSummaries())[0]?.quality.maintainability, null);
});

test('range saves expose complete commit reports before publishing the combined summary', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-deferred-summary-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const first = report('a', '2026-01-01T00:00:00.000Z', 20);
  const second = report('b', '2026-02-01T00:00:00.000Z', 30);
  await store.save(first, { deferSummary: true });
  assert.deepEqual(await store.read(first.subject), first);
  await assert.rejects(readFile(join(output, 'summary.json')), { code: 'ENOENT' });
  await store.save(second, { deferSummary: true });
  await store.refreshSummary();
  const summary = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.commits.map(({ sha }: { sha: string }) => sha), [second.subject.id, first.subject.id]);
});
