import type { DataContract } from '../engine/plugin.js';
import { isRecord } from './plugin-data.js';

export interface FileCoverage {
  readonly path: string;
  readonly addedLines: number;
  readonly covered: number | null;
  readonly total: number | null;
}

export interface DiffCoverage {
  readonly status: 'complete' | 'partial' | 'not-applicable';
  readonly covered: number;
  readonly total: number;
  readonly percent: number | null;
  readonly files: readonly FileCoverage[];
  readonly gaps: readonly { readonly path: string; readonly reason: string }[];
}

export interface DiffCoverageResult extends DiffCoverage {
  readonly uncovered: readonly { readonly path: string; readonly lines: readonly number[] }[];
}

export const diffCoverageResult: DataContract<DiffCoverageResult> = {
  id: 'repometry.diff-coverage-result/v1',
  accepts: (value): value is DiffCoverageResult => isRecord(value) && Array.isArray(value.files) && Array.isArray(value.gaps)
    && Array.isArray(value.uncovered)
    && (value.status === 'complete' || value.status === 'partial' || value.status === 'not-applicable')
    && typeof value.covered === 'number' && typeof value.total === 'number'
    && (value.percent === null || typeof value.percent === 'number'),
};
