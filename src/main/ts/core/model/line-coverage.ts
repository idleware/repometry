import { isRecord } from '../engine/plugin.js';
import type { DataContract } from '../engine/plugin.js';

export type CoveredLineRange = readonly [first: number, last: number];

export interface FileLineCoverage {
  readonly covered: readonly CoveredLineRange[];
  readonly uncovered: readonly CoveredLineRange[];
  readonly partial?: readonly CoveredLineRange[];
}

export type LineCoverage = Readonly<Record<string, FileLineCoverage>>;

export const lcovLines: DataContract<LineCoverage> = {
  id: 'repometry.lcov-lines/v1',
  accepts: (value): value is LineCoverage => isRecord(value) && Object.values(value).every(file =>
    isRecord(file) && isMerged(file.covered) && isMerged(file.uncovered) &&
    (file.partial === undefined || isMerged(file.partial))),
};

function isMerged(value: unknown): value is readonly CoveredLineRange[] {
  if (!Array.isArray(value)) return false;
  let previous = -1;
  for (const range of value as unknown[]) {
    if (!Array.isArray(range) || range.length !== 2) return false;
    const [first, last] = range as unknown[];
    if (typeof first !== 'number' || typeof last !== 'number' || !Number.isSafeInteger(first)
      || !Number.isSafeInteger(last) || first <= previous + 1 || last < first) return false;
    previous = last;
  }
  return true;
}
