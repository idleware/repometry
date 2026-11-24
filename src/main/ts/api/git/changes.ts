import { gitText, gitUtf8 } from './git.js';
import { physicalLines, utf8 } from '../../core/model/snapshot.js';
import type { SourceSnapshot } from '../../core/model/snapshot.js';

import type { GitChanges, LineRange } from '../../core/model/changes.js';
export type { GitChanges, LineRange } from '../../core/model/changes.js';

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const regularFile = /^100(?:644|755)$/;
export const diffMethod = { algorithm: 'myers', indentHeuristic: false, renameThresholdPercent: 50, renameLimit: 1000 } as const;
const stableDiff = ['--no-color', '--no-ext-diff', '--no-textconv', `--diff-algorithm=${diffMethod.algorithm}`, '--no-indent-heuristic'] as const;

export async function findMergeBase(repository: string, base: string, head: string): Promise<string> {
  if (!oid.test(base) || !oid.test(head)) throw new Error('Merge base requires full commit IDs');
  let found: string;
  try {
    found = await gitText(repository, ['merge-base', '--all', base, head]);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) {
      throw new Error('No merge base found. Make the histories for both commits available locally.');
    }
    throw error;
  }
  const candidates = found.trim().split(/\s+/);
  const first = candidates[0];
  if (candidates.length !== 1 || !first || !oid.test(first)) throw new Error('The selected commits need one unambiguous merge base');
  return first;
}

export async function readChanges(repository: string, base: string, head: SourceSnapshot,
  excludes: (path: string) => boolean, isSource: (path: string) => boolean): Promise<GitChanges> {
  if (!oid.test(base) || head.subject.kind !== 'commit' || !oid.test(head.subject.id)) throw new Error('Git diff requires full commit IDs');
  const files = new Map<string, readonly LineRange[]>();
  const gaps = new Map<string, string>();
  if (base === head.subject.id) return { files, gaps };

  const contents = new Map(head.files.map(file => [file.path, file.bytes]));
  const raw = await gitUtf8(repository, ['diff', ...stableDiff, '--raw', '-z', '--no-abbrev',
    `--find-renames=${diffMethod.renameThresholdPercent}%`, `-l${diffMethod.renameLimit}`, base, head.subject.id, '--']);
  for (const change of rawChanges(raw)) {
    const bytes = contents.get(change.path);
    if (!bytes || !regularFile.test(change.mode)) continue;
    const before = change.previous && isSource(change.previous.path) && !excludes(change.previous.path)
      ? change.previous.oid : undefined;
    if (before === change.oid) continue;
    let source: string;
    try {
      source = utf8(bytes);
    } catch {
      gaps.set(change.path, 'Changed source is not valid UTF-8');
      continue;
    }
    if (/\0|\r(?!\n)|[\u2028\u2029]/.test(source)) {
      gaps.set(change.path, 'Git and LCOV line coordinates may differ for this file');
      continue;
    }
    const length = physicalLines(source);
    const ranges = before
      ? addedRanges(await gitText(repository, ['diff', ...stableDiff, '--text', '--unified=0', '--inter-hunk-context=0', before, change.oid, '--']))
      : (length === 0 ? [] : [{ first: 1, last: length }]);
    if (ranges.some(range => range.last > length)) throw new Error('Git reported changes beyond the source lines');
    if (ranges.length > 0) files.set(change.path, ranges);
  }
  return { files, gaps };
}

interface RawChange {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly previous?: { readonly path: string; readonly oid: string };
}

export function rawChanges(text: string): readonly RawChange[] {
  if (text === '') return [];
  const fields = text.split('\0');
  if (fields.pop() !== '') throw new Error('Invalid Git raw diff terminator');
  const changes: RawChange[] = [];
  for (let i = 0; i < fields.length;) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ACDMRT])\d*$/.exec(fields[i++] ?? '');
    const oldPath = fields[i++];
    const status = header?.[5];
    const path = status === 'C' || status === 'R' ? fields[i++] : oldPath;
    const oldId = header?.[3];
    const newId = header?.[4];
    const mode = header?.[2];
    if (!oldPath || !path || !mode || !oldId || !newId || !oid.test(oldId) || !oid.test(newId)) {
      throw new Error('Invalid Git raw diff entry');
    }
    const previous = status !== 'A' && status !== 'C' && regularFile.test(header![1]!)
      ? { path: oldPath, oid: oldId } : undefined;
    changes.push({ path, mode, oid: newId, previous });
  }
  return changes;
}

export function addedRanges(patch: string): readonly LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of patch.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (!match) continue;
    const first = Number(match[1]);
    const count = Number(match[2] ?? 1);
    if (count === 0) continue;
    const last = first + count - 1;
    if (first < 1 || !Number.isSafeInteger(last) || first <= (ranges.at(-1)?.last ?? 0)) throw new Error('Invalid Git diff hunk range');
    ranges.push({ first, last });
  }
  return ranges;
}
