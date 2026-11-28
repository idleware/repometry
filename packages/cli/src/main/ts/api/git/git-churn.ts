import { gitText, gitUtf8 } from './git.js';

import { churnSettings } from '@repometry/core/internal/model/churn.js';
import type { ChurnWindow } from '@repometry/core/internal/model/churn.js';
export { churnSettings } from '@repometry/core/internal/model/churn.js';
export type { ChurnWindow } from '@repometry/core/internal/model/churn.js';

interface Churn {
  readonly touches: ReadonlyMap<string, number>;
  readonly window: ChurnWindow;
}

const maxTimeMs = 8000;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function gitChurn(directory: string, commit: string, paths: readonly string[]): Promise<Churn> {
  if (!oid.test(commit)) throw new Error('Git history requires a full commit ID');
  const [log, shallow] = await Promise.all([
    gitUtf8(directory, ['-c', 'log.showRoot=false', 'log', '--first-parent', '--diff-merges=first-parent',
      `--max-count=${churnSettings.maxCommits + 1}`, '--format=%x00%H %ct %P', '--name-only', '-z',
      '--no-renames', '--no-notes', '--no-color', '--no-ext-diff', '--no-textconv', commit, '--'], maxTimeMs),
    gitText(directory, ['rev-parse', '--is-shallow-repository'], maxTimeMs),
  ]);
  return summarizeGitHistory(log, commit, paths, shallow.trim() === 'true');
}

export function summarizeGitHistory(log: string, commit: string, paths: readonly string[], shallow: boolean): Churn {
  const touches = new Map(paths.map(path => [path, 0]));
  let visited = 0;
  let commits = 0;
  let endingAt: number | undefined;
  let capReached = false;
  for (const record of gitRecords(log)) {
    if (endingAt === undefined && record.sha !== commit) throw new Error('Git history did not start at the inspected commit');
    endingAt ??= record.timestamp;
    if (visited++ >= churnSettings.maxCommits) {
      capReached = true;
      break;
    }
    // Only commits with a parent, inside the window that ends at the inspected commit, count.
    if (!record.hasParent || record.timestamp < endingAt - churnSettings.lookbackDays * 86400 || record.timestamp > endingAt) continue;
    commits++;
    for (const path of new Set(record.paths)) if (touches.has(path)) touches.set(path, touches.get(path)! + 1);
  }
  if (endingAt === undefined) throw new Error('Empty Git history');
  return {
    touches: shallow && commits === 0 ? new Map() : touches,
    window: { endingAt: new Date(endingAt * 1000).toISOString(), commits, shallow, capReached },
  };
}

interface GitRecord {
  readonly sha: string;
  readonly timestamp: number;
  readonly hasParent: boolean;
  readonly paths: readonly string[];
}

/** The records of `git log -z --format=%x00%H %ct %P --name-only`: a header field, then path fields up to an empty one. */
function* gitRecords(log: string): Generator<GitRecord> {
  const fields = log.split('\0');
  if (fields[0] !== '' || fields.at(-1) !== '') throw new Error('Invalid Git history record');
  let index = 1;
  while (index < fields.length - 1) {
    const header = recordHeader(fields[index++]!);
    const paths: string[] = [];
    // Git starts each record's path list on a new line.
    for (; index < fields.length && fields[index] !== ''; index++) paths.push(paths.length ? fields[index]! : fields[index]!.replace(/^\n/, ''));
    index++;
    yield { ...header, paths };
  }
}

function recordHeader(field: string): Omit<GitRecord, 'paths'> {
  const [sha, date, ...parents] = field.split(' ');
  const timestamp = Number(date);
  const hasParent = parents.length > 0 && parents.every(parent => oid.test(parent));
  const root = parents.length === 1 && parents[0] === '';
  const named = sha !== undefined && oid.test(sha) && date !== undefined && /^\d+$/.test(date);
  if (!named || !Number.isSafeInteger(timestamp) || (!hasParent && !root)) throw new Error('Invalid Git history record');
  return { sha: sha!, timestamp, hasParent };
}
