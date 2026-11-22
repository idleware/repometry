import { gitText, gitUtf8 } from './git.js';

import { churnSettings } from '../../core/model/churn.js';
import type { ChurnWindow } from '../../core/model/churn.js';
export { churnSettings } from '../../core/model/churn.js';
export type { ChurnWindow } from '../../core/model/churn.js';

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
  const fields = log.split('\0');
  if (fields[0] !== '' || fields.at(-1) !== '') throw new Error('Invalid Git history record');
  const touches = new Map(paths.map(path => [path, 0]));
  let index = 1;
  let visited = 0;
  let commits = 0;
  let endingAt: number | undefined;
  let capReached = false;
  while (index < fields.length - 1) {
    const [sha, date, ...parents] = fields[index++]!.split(' ');
    const timestamp = Number(date);
    const hasParent = parents.length > 0 && parents.every(parent => oid.test(parent));
    const root = parents.length === 1 && parents[0] === '';
    if (sha === undefined || !oid.test(sha) || date === undefined || !/^\d+$/.test(date) || !Number.isSafeInteger(timestamp) || (!hasParent && !root)) {
      throw new Error('Invalid Git history record');
    }
    if (endingAt === undefined) {
      if (sha !== commit) throw new Error('Git history did not start at the inspected commit');
      endingAt = timestamp;
    }
    if (visited >= churnSettings.maxCommits) {
      capReached = true;
      break;
    }
    visited++;

    const cutoff = endingAt - churnSettings.lookbackDays * 86400;
    const overlaps = hasParent && timestamp >= cutoff && timestamp <= endingAt;
    const changed = new Set<string>();
    let first = true;
    while (index < fields.length && fields[index] !== '') {
      const path = fields[index++]!;
      if (overlaps) {
        const normalized = first ? path.replace(/^\n/, '') : path;
        if (touches.has(normalized)) changed.add(normalized);
      }
      first = false;
    }
    index++;
    if (overlaps) commits++;
    for (const path of changed) touches.set(path, touches.get(path)! + 1);
  }
  if (endingAt === undefined) throw new Error('Empty Git history');
  return {
    touches: shallow && commits === 0 ? new Map() : touches,
    window: { endingAt: new Date(endingAt * 1000).toISOString(), commits, shallow, capReached },
  };
}
