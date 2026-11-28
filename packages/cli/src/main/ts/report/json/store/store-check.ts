import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Subject } from '@repometry/core/internal/model/source.js';
import { repositorySummary } from '../projections/commit-summary.js';
import { readStoredReport } from '../validation/report.js';
import { hasCode } from './directory.js';
import { LocalReportStore } from './local-store.js';
import { ObjectError, objectId, objectPath, objectText } from './report-tree.js';
import type { ObjectSource } from './report-tree.js';

export const storeCheckSchema = 'urn:repometry:schema:store-check:1';

/** Objects this recent may belong to a save that has not published its report yet. */
const unreferencedGraceMs = 60 * 60 * 1000;

export interface StoreProblem {
  readonly subject: Subject;
  readonly problem: 'missing-objects' | 'corrupt-objects' | 'unreadable';
  readonly objects?: readonly string[];
  readonly message: string;
}

export interface StoreCheck {
  readonly schema: typeof storeCheckSchema;
  readonly reports: number;
  readonly objects: number;
  readonly unreferenced: number;
  readonly summary: 'current' | 'stale';
  readonly problems: readonly StoreProblem[];
  readonly repaired?: { readonly restored: number; readonly removed: number; readonly summary: boolean };
}

export interface StoreRepair {
  /** Another copy of the objects, such as the storage branch, to restore missing or corrupt ones from. */
  readonly from?: ObjectSource;
}

/**
 * Verifies every saved report: its objects exist and match their IDs, and the report rebuilds to the revision
 * in its header. With `repair`, restores objects from `from`, removes old unreferenced objects and refreshes
 * summary.json. A report that stays broken needs `repometry analyze` again.
 */
export async function checkStore(directory: string, repair?: StoreRepair): Promise<StoreCheck> {
  const target = await stat(directory).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return undefined;
    throw error;
  });
  if (target === undefined) throw new Error(`No report store at ${directory}. Run repometry analyze first.`);
  if (!target.isDirectory()) throw new Error(`Expected a report store directory: ${directory}`);
  const store = new LocalReportStore(directory);
  const reachable = new Set<string>();
  const problems: StoreProblem[] = [];
  const counts = { restored: 0, removed: 0 };
  const subjects = await store.subjects();
  for (const subject of subjects) {
    const result = await checkReport(store, subject, repair);
    for (const id of result.ids) reachable.add(id);
    if (result.problem) problems.push(result.problem);
    counts.restored += result.restored;
  }
  const unreferenced = (await store.objects.ids()).filter(id => !reachable.has(id));
  // While a report is broken, objects under its missing directories look unreferenced: keep them.
  if (repair && problems.length === 0) counts.removed = await removeOld(store, directory, unreferenced);
  const stale = await summaryStale(store, directory);
  if (repair && stale) await store.refreshSummary();
  return {
    schema: storeCheckSchema, reports: subjects.length, objects: reachable.size, unreferenced: unreferenced.length - counts.removed,
    summary: stale && !repair ? 'stale' : 'current', problems,
    ...(repair ? { repaired: { ...counts, summary: stale } } : {}),
  };
}

interface ReportCheck {
  readonly ids: ReadonlySet<string>;
  readonly problem?: StoreProblem;
  readonly restored: number;
}

/** Single-file reports saved before objects have no objects to check; reading them verifies their revision. */
async function checkReport(store: LocalReportStore, subject: Subject, repair?: StoreRepair): Promise<ReportCheck> {
  let text: string;
  try {
    text = await store.text(subject);
  } catch (error) {
    return { ids: new Set(), restored: 0, problem: unreadable(subject, error) };
  }
  let restored = 0;
  for (;;) {
    const { ids, failed, error } = await verify(store, text, subject);
    const count = failed.size && repair?.from ? await restore(store, repair.from, [...failed.keys()]) : 0;
    restored += count;
    if (count) continue;
    const problem = failed.size ? objectProblem(subject, failed) : error === undefined ? undefined : unreadable(subject, error);
    return { ids, restored, ...(problem ? { problem } : {}) };
  }
}

/** Reads a report through objects checked against their IDs, noting each object it reaches and each it cannot read. */
async function verify(store: LocalReportStore, text: string, subject: Subject) {
  const ids = new Set<string>();
  const failed = new Map<string, ObjectError['reason']>();
  const reads: Promise<unknown>[] = [];
  const objects: ObjectSource = {
    async read(list) {
      const pending = list.map(async id => {
        ids.add(id);
        try {
          return JSON.parse(objectText(id, await store.objects.bytes(id))) as unknown;
        } catch (error) {
          if (!(error instanceof ObjectError)) throw error;
          failed.set(id, error.reason);
          return undefined;
        }
      });
      reads.push(...pending);
      const values = await Promise.all(pending);
      if (failed.size) throw new ObjectError([...failed.keys()][0]!, [...failed.values()][0]!);
      return values;
    },
  };
  try {
    await readStoredReport(text, subject, objects);
    return { ids, failed };
  } catch (error) {
    // Let reads already under way finish, so every damaged object they reach is reported.
    await Promise.allSettled(reads);
    return { ids, failed, error };
  }
}

async function restore(store: LocalReportStore, from: ObjectSource, ids: readonly string[]): Promise<number> {
  const copies = new Map<string, string>();
  for (const id of ids) {
    try {
      const text = JSON.stringify((await from.read([id]))[0]);
      if (objectId(text) === id.slice(0, 32)) copies.set(id, text);
    } catch (error) {
      if (!(error instanceof ObjectError)) throw error;
    }
  }
  await store.objects.write(copies);
  return copies.size;
}

async function removeOld(store: LocalReportStore, directory: string, ids: readonly string[]): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    if (Date.now() - (await lstat(join(directory, objectPath(id)))).mtimeMs < unreferencedGraceMs) continue;
    await store.objects.remove(id);
    removed++;
  }
  return removed;
}

async function summaryStale(store: LocalReportStore, directory: string): Promise<boolean> {
  const expected = `${JSON.stringify(repositorySummary(await store.listSummaries()))}\n`;
  try {
    return await readFile(join(directory, 'summary.json'), 'utf8') !== expected;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return (await store.listSummaries()).length > 0;
    throw error;
  }
}

function objectProblem(subject: Subject, failed: ReadonlyMap<string, ObjectError['reason']>): StoreProblem {
  const missing = [...failed.values()].includes('missing');
  return { subject, problem: missing ? 'missing-objects' : 'corrupt-objects', objects: [...failed.keys()],
    message: `Restore with repometry store check --repair --from git:repometry, or run repometry analyze ${subject.kind === 'commit' ? subject.id : '--working-tree'}.` };
}

function unreadable(subject: Subject, error: unknown): StoreProblem {
  return { subject, problem: 'unreadable', message: error instanceof Error ? error.message : String(error) };
}
