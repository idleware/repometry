import type { DiffCoverage } from './diff-coverage.js';
import type { InspectionComparison } from './comparison.js';
import type { Finding } from './finding.js';

export const pullReviewSchema = 'urn:repometry:schema:pull-review:1';

type LineCoverage = InspectionComparison['metrics']['lineCoverage'];
type GateStatus = 'passed' | 'failed' | 'not-applicable' | 'indeterminate';

export interface PullReview {
  readonly schema: typeof pullReviewSchema;
  readonly number: number | null;
  readonly generatedAt: string;
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly coverage: {
    readonly base: LineCoverage['baseline'] | null;
    readonly head: LineCoverage['current'] | null;
    readonly delta: number | null;
    readonly reason: LineCoverage['reason'] | 'reports-unavailable' | 'head-coverage-changed';
    readonly gate: { readonly status: GateStatus; readonly maxDrop: number } | null;
  };
  readonly diff: Pick<DiffCoverage, 'covered' | 'total' | 'percent' | 'files' | 'gaps'> & {
    readonly status: DiffCoverage['status'] | 'unavailable';
    readonly excludedPaths: readonly string[] | null;
    readonly coverageInputDigest: string | null;
    readonly uncovered: readonly { readonly path: string; readonly lines: readonly number[] }[];
    readonly gate: { readonly status: GateStatus; readonly minimumPercent: number; readonly minimumLines: number } | null;
  };
  readonly findings: {
    readonly added: readonly Finding[] | null;
    readonly qualityCount: number | null;
    readonly reason: 'reports-unavailable' | 'findings-unavailable' | 'partial-inspection' | 'analysis-changed' | null;
    readonly gate: { readonly status: GateStatus; readonly maximum: number } | null;
  };
}
