import type { Finding, FindingLocation } from './finding.js';

export const pullReviewSchema = 'urn:repometry:schema:pull-review:2';
/** GitHub shows at most this many annotations of each kind per step. */
export const annotationLimit = 10;

export type IssueEffect = 'new' | 'worsened' | 'improved' | 'touched';

/** What a change did to one issue on the lines it changed. */
export interface ReviewedIssue {
  readonly effect: IssueEffect;
  /** The head finding, or the base finding when the change fixed it. A duplicate is placed on a changed copy. */
  readonly finding: Finding;
  /** The base value of a matched issue. */
  readonly before: number | null;
  /** The base had the issue and the head doesn't. */
  readonly fixed: boolean;
  /** A duplicate's other copies. */
  readonly context: readonly FindingLocation[];
  /** Effort minutes this change added (positive) or removed (negative). */
  readonly debtMinutes: number;
}

export interface ReviewReason {
  readonly message: string;
  readonly path?: string;
  readonly operation?: string;
}

/** What a change did on the lines it changed: issues by effect, changed-line coverage, and the two gates. */
export interface PullReview {
  readonly schema: typeof pullReviewSchema;
  readonly number: number | null;
  readonly generatedAt: string;
  /** The base as requested, such as `origin/main`. */
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  /** Files the change added, edited, renamed or deleted. */
  readonly changedFiles: number;
  readonly verdict: 'passed' | 'failed' | 'unmeasured';
  readonly issues: readonly ReviewedIssue[];
  readonly debt: { readonly added: number; readonly removed: number };
  readonly coverage: {
    readonly imported: boolean;
    readonly covered: number;
    readonly total: number;
    readonly percent: number | null;
    readonly uncovered: readonly { readonly path: string; readonly first: number; readonly last: number }[];
    readonly unmapped: readonly { readonly path: string; readonly reason: string }[];
    readonly gate: { readonly minimumPercent: number; readonly minimumLines: number;
      readonly status: 'passed' | 'failed' | 'not-applicable' } | null;
  };
  readonly issueGate: { readonly maximum: number; readonly count: number; readonly status: 'passed' | 'failed' };
  /** Measurements the check needs that the head lacks: the review can't vouch for the change. */
  readonly unmeasured: readonly ReviewReason[];
  readonly notes: readonly ReviewReason[];
}
