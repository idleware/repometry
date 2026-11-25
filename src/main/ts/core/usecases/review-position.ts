import type { FileLineChange } from '../model/changes.js';
import type { Finding } from '../model/finding.js';

/** A base finding and a head finding the diff places at the same lines. */
export interface PositionMatch {
  readonly base: Finding;
  readonly head: Finding;
}

/**
 * Pairs by position, best first: most of a base finding's lines, carried through the diff, land inside a head finding of
 * the same rule. More carried lines win, then the same anchor, then the closer size.
 */
export function positionMatches(base: readonly Finding[], head: readonly Finding[], byBase: ReadonlyMap<string, FileLineChange>,
  headPath: (path: string) => string | null): PositionMatch[] {
  const found: (PositionMatch & { readonly score: readonly number[] })[] = [];
  for (const from of base.filter(located)) {
    const carried = carriedLines(from, byBase.get(from.path!));
    const target = headPath(from.path!);
    for (const to of head.filter(item => located(item) && item.rule === from.rule && item.path === target)) {
      const overlap = carried.filter(line => line >= to.line! && line <= end(to)).length;
      if (overlap * 2 > size(from)) {
        found.push({ base: from, head: to, score: [overlap, Number(from.anchor === to.anchor), -Math.abs(size(from) - size(to))] });
      }
    }
  }
  return found.sort((left, right) => right.score[0]! - left.score[0]! || right.score[1]! - left.score[1]! || right.score[2]! - left.score[2]!);
}

/** Where an unchanged base line sits on the head side; undefined for a changed line or a file without a counterpart. */
export function headLine(file: FileLineChange | undefined, line: number): number | undefined {
  if (file === undefined) return line;
  if (file.whole || file.path === null) return undefined;
  let offset = 0;
  for (const { base, head } of file.hunks) {
    const last = base.first + base.count - 1;
    if (base.count > 0 && line >= base.first && line <= last) return undefined;
    if (base.count > 0 ? last < line : base.first < line) offset += head.count - base.count;
  }
  return line + offset;
}

function carriedLines(finding: Finding, file: FileLineChange | undefined): number[] {
  const lines: number[] = [];
  for (let line = finding.line!; line <= end(finding); line++) {
    const moved = headLine(file, line);
    if (moved !== undefined) lines.push(moved);
  }
  return lines;
}

function located(finding: Finding): boolean {
  return finding.path !== undefined && finding.line !== undefined && finding.category !== 'duplication';
}

function end(finding: Finding): number {
  return finding.endLine ?? finding.line!;
}

function size(finding: Finding): number {
  return end(finding) - finding.line! + 1;
}
