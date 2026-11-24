import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { definitions } from '../../main/ts/core/model/measurement.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import { reportSchema } from '../../main/ts/report/json/validation/report.js';
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

test('stored snapshots intern repeated paths and still expose complete reports', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-storage-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const original = report('a', '2026-01-01T00:00:00.000Z', 20);
  const path = 'src/nested/component.ts';
  const content: Report = {
    ...original,
    definitions: { ...original.definitions, [definitions.coverage]: 'Line coverage' },
    measurements: [...original.measurements, { definition: definitions.coverage, target: 'file', path, value: null, covered: 0, total: 0 }],
    findings: [{ tool: 'lint', rule: 'structure', category: 'lint', level: 'low', path, line: 1, message: 'Keep detail',
      related: [{ path, line: 2, endLine: 5 }] }],
  };
  await store.save(content);
  const saved = await readFile(join(output, 'commits', original.subject.id, 'report.json'), 'utf8');
  assert.equal(saved.split(path).length - 1, 1);
  assert.deepEqual(await store.read(original.subject), content);
});

test('stored reports reject a string table edit that moves measurements between files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'repometry-storage-revision-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const store = new LocalReportStore(output);
  const original = report('a', '2026-01-01T00:00:00.000Z', 20);
  const first = original.measurements[0]!;
  const second = { ...first, path: 'src/other.ts', value: 7 };
  await store.save({ ...original, measurements: [first, second] });
  const file = join(output, 'commits', original.subject.id, 'report.json');
  const envelope: { strings: string[] } = JSON.parse(await readFile(file, 'utf8'));
  const a = envelope.strings.indexOf(first.path!);
  const b = envelope.strings.indexOf(second.path);
  assert.ok(a >= 0 && b >= 0);
  [envelope.strings[a], envelope.strings[b]] = [envelope.strings[b]!, envelope.strings[a]!];
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(store.read(original.subject), /Report revision mismatch/);
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
