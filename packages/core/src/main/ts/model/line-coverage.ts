import { isRecord } from './plugin-data.js';
import type { DataContract } from '../engine/plugin.js';
import { isMergedLineRanges } from './source.js';
import type { SourceLineRange } from './source.js';

export type CoveredLineRange = SourceLineRange;
export type HitRun = readonly [first: number, last: number, count: number];
export type FunctionCallCount = readonly [line: number, calls: number];

export interface FileLineCoverage {
  readonly covered: readonly CoveredLineRange[];
  readonly uncovered: readonly CoveredLineRange[];
  readonly partial?: readonly CoveredLineRange[];
  readonly hits?: readonly HitRun[];
  readonly functionCalls?: readonly FunctionCallCount[];
  readonly functionBodies?: readonly SourceLineRange[];
}

export type LineCoverage = Readonly<Record<string, FileLineCoverage>>;

export const lcovLines: DataContract<LineCoverage> = {
  id: 'repometry.lcov-lines/v1',
  accepts: (value): value is LineCoverage => isRecord(value) && Object.values(value).every(file =>
    isRecord(file) && isMergedLineRanges(file.covered) && isMergedLineRanges(file.uncovered)
    && (file.partial === undefined || isMergedLineRanges(file.partial)) && (file.hits === undefined || isMergedHits(file.hits))
    && (file.functionCalls === undefined || isOrderedCallCounts(file.functionCalls))
    && (file.functionBodies === undefined || isMergedLineRanges(file.functionBodies))),
};

function isOrderedCallCounts(value: unknown): value is readonly FunctionCallCount[] {
  if (!Array.isArray(value)) return false;
  let previous = 1;
  for (const call of value as unknown[]) {
    if (!Array.isArray(call) || call.length !== 2) return false;
    const [line, count] = call as unknown[];
    if (typeof line !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(line) || !Number.isSafeInteger(count)
      || line < previous || count < 0) return false;
    previous = line;
  }
  return true;
}

function isMergedHits(value: unknown): value is readonly HitRun[] {
  if (!Array.isArray(value)) return false;
  let previousEnd = 0;
  let previousCount = -1;
  for (const run of value as unknown[]) {
    if (!Array.isArray(run) || run.length !== 3) return false;
    const [first, last, count] = run as unknown[];
    if (typeof first !== 'number' || typeof last !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(first)
      || !Number.isSafeInteger(last) || !Number.isSafeInteger(count) || first <= previousEnd || last < first || count < 0
      || (first === previousEnd + 1 && count === previousCount)) return false;
    previousEnd = last;
    previousCount = count;
  }
  return true;
}
