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
