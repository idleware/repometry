import type { LineChanges, LineRange } from '../model/changes.js';
import type { Finding, FindingLocation } from '../model/finding.js';

/** A side's source text, line by line; undefined past the end of a file or for unreadable content. */
export interface SourceLines {
  line(path: string, line: number): string | undefined;
}

/** One side of a change: its changed lines by path, and its source text. */
export interface ReviewSide {
  readonly ranges: ReadonlyMap<string, readonly LineRange[] | 'whole'>;
  readonly lines: SourceLines;
}

/** The base side's modified and removed lines, or the head side's added and modified ones. */
export function reviewSide(changes: LineChanges, side: 'base' | 'head', lines: SourceLines): ReviewSide {
  const ranges = new Map<string, readonly LineRange[] | 'whole'>();
  for (const file of changes.files) {
    const path = side === 'head' ? file.path : file.previous;
    if (path !== null) ranges.set(path, file.whole ? 'whole' : side === 'head' ? file.added : file.removed);
  }
  return { ranges, lines };
}

/** A finding is in scope when it sits on changed lines; one without a line, or past its file's end, when its file changed. */
export function inScope(finding: Finding, side: ReviewSide): boolean {
  if (finding.path === undefined) return false;
  if (finding.category === 'duplication') return locations(finding).some(copy => locationInScope(copy.path, copy.line, copy.endLine, side));
  const fileLevel = finding.line === undefined || side.lines.line(finding.path, finding.line) === undefined;
  return fileLevel ? side.ranges.has(finding.path) : locationInScope(finding.path, finding.line!, finding.endLine ?? finding.line!, side);
}

function locationInScope(path: string, line: number, endLine: number, side: ReviewSide): boolean {
  const ranges = side.ranges.get(path);
  return ranges === 'whole' || (ranges?.some(range => range.first <= endLine && range.last >= line) ?? false);
}

function locations(finding: Finding): FindingLocation[] {
  const primary = { path: finding.path!, line: finding.line!, endLine: finding.endLine ?? finding.line! };
  return [primary, ...finding.related ?? []];
}

/** A duplicate shows on its first changed copy, with the others as context. Other findings stay where they are. */
export function placed(finding: Finding, side: ReviewSide): { finding: Finding; context: readonly FindingLocation[] } {
  if (finding.category !== 'duplication' || finding.path === undefined || finding.line === undefined) return { finding, context: [] };
  const copies = locations(finding).sort((left, right) => compare(left.path, right.path) || left.line - right.line);
  const shown = copies.find(copy => locationInScope(copy.path, copy.line, copy.endLine, side)) ?? copies[0]!;
  const { related: _related, ...rest } = finding;
  return { finding: { ...rest, path: shown.path, line: shown.line, endLine: shown.endLine },
    context: copies.filter(copy => copy !== shown) };
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
