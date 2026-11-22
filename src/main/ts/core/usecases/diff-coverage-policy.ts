import type { DiffCoverage } from '../model/diff-coverage.js';

export interface CoverageDecision {
  readonly status: 'passed' | 'failed' | 'not-applicable' | 'indeterminate';
  readonly minimumPercent: number;
}

export function assessDiffCoverage(result: DiffCoverage, minimumPercent: number): CoverageDecision {
  if (!Number.isFinite(minimumPercent) || minimumPercent < 0 || minimumPercent > 100) {
    throw new Error('Minimum diff coverage must be a percentage from 0 to 100');
  }
  if (result.status === 'partial') return { status: 'indeterminate', minimumPercent };
  if (result.percent === null) return { status: 'not-applicable', minimumPercent };
  return { status: result.percent >= minimumPercent ? 'passed' : 'failed', minimumPercent };
}
