import type { LineChanges } from '../model/changes.js';
import { pullReviewSchema } from '../model/pull-review.js';
import type { PullReview, ReviewReason } from '../model/pull-review.js';
import { isRecord } from '../model/plugin-data.js';
import type { Diagnostic, Report } from '../model/report.js';
import { classifyIssues, debtEffect } from './review-effect.js';
import type { SourceLines } from './review-effect.js';
import type { DiffCoverageReport } from './diff-coverage.js';

export interface ReviewOptions {
  readonly number?: number;
  readonly minimumPercent?: number;
  readonly minimumLines?: number;
  readonly maxNewIssues?: number;
}

export interface ReviewInputs {
  /** The base as requested, such as `origin/main`. */
  readonly requestedBase: string;
  /** The inspection of the merge base. */
  readonly base: Report;
  readonly head: Report;
  readonly changes: LineChanges;
  readonly sources: { readonly base: SourceLines; readonly head: SourceLines };
  readonly coverage: { readonly report: DiffCoverageReport; readonly uncovered: readonly { readonly path: string; readonly lines: readonly number[] }[] } | null;
  /** The change edits Repometry's settings. */
  readonly settingsChanged: boolean;
}

export const coverageDefaults = { minimumPercent: 80, minimumLines: 20 } as const;
const hostOperations = new Set(['git/churn', 'source/claims']);
const settingsNote = 'This change edits Repometry settings, which can hide issues from this check.';

export function projectReview(options: ReviewOptions, inputs: ReviewInputs): PullReview {
  checkOptions(options, inputs.coverage !== null);
  const { number, maxNewIssues = 0 } = options;
  const issues = classifyIssues(inputs.base.findings ?? [], inputs.head.findings ?? [], inputs.changes, inputs.sources);
  const count = issues.filter(issue => issue.effect === 'new' || issue.effect === 'worsened').length;
  const issueGate = { maximum: maxNewIssues, count, status: count > maxNewIssues ? 'failed' as const : 'passed' as const };
  const coverage = changedCoverage(options, inputs.coverage);
  const { unmeasured, notes } = diagnose(inputs);
  const failed = issueGate.status === 'failed' || coverage.gate?.status === 'failed';
  return { schema: pullReviewSchema, number: number ?? null, generatedAt: new Date().toISOString(),
    base: inputs.requestedBase, mergeBase: inputs.base.subject.id, head: inputs.head.subject.id, changedFiles: inputs.changes.files.length,
    verdict: unmeasured.length ? 'unmeasured' : failed ? 'failed' : 'passed',
    issues, debt: debtEffect(issues), coverage, issueGate, unmeasured,
    notes: inputs.settingsChanged ? [...notes, { message: settingsNote }] : notes };
}

/** Throws for options the review can't apply. */
export function checkOptions({ number, maxNewIssues = 0, minimumPercent }: ReviewOptions, coverage: boolean): void {
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) throw new Error('Pull request number must be a positive integer');
  if (!Number.isSafeInteger(maxNewIssues) || maxNewIssues < 0) throw new Error('Maximum new issues must be a non-negative integer');
  if (minimumPercent !== undefined && !coverage) throw new Error('Minimum changed-line coverage requires --import lcov=PATH, go-cover=PATH or cobertura=PATH');
}

/** The verdict and its reason, in one line. */
export function reviewReason({ verdict, unmeasured, issueGate, coverage }: PullReview): string {
  if (verdict === 'unmeasured') {
    const [first] = unmeasured;
    const more = unmeasured.length > 1 ? `, and ${unmeasured.length - 1} more` : '';
    return `Review not measured: ${first!.operation}${first!.path === undefined ? '' : ` on ${first!.path}`}: ${first!.message}${more}.`;
  }
  const reasons: string[] = [];
  if (issueGate.status === 'failed') {
    reasons.push(`${issueGate.count} new or worsened ${issueGate.count === 1 ? 'issue' : 'issues'} on the changed lines, ${issueGate.maximum} allowed`);
  }
  if (coverage.gate?.status === 'failed') {
    reasons.push(`changed-line coverage ${coverage.percent!.toFixed(2)}% is under the ${coverage.gate.minimumPercent}% minimum`);
  }
  return reasons.length ? `Review failed: ${reasons.join('; ')}.` : 'Review passed.';
}

export function reviewExitCode(review: PullReview): 0 | 2 | 3 {
  return review.verdict === 'unmeasured' ? 2 : review.verdict === 'failed' ? 3 : 0;
}

function changedCoverage(options: ReviewOptions, input: ReviewInputs['coverage']): PullReview['coverage'] {
  if (input === null) return { imported: false, covered: 0, total: 0, percent: null, uncovered: [], unmapped: [], gate: null };
  const { minimumPercent = coverageDefaults.minimumPercent, minimumLines = coverageDefaults.minimumLines } = options;
  if (!Number.isFinite(minimumPercent) || minimumPercent < 0 || minimumPercent > 100) {
    throw new Error('Minimum changed-line coverage must be a percentage from 0 to 100');
  }
  if (!Number.isSafeInteger(minimumLines) || minimumLines < 0) throw new Error('Minimum changed lines must be a non-negative integer');
  const { covered, total, percent, gaps } = input.report;
  const status = total < minimumLines || percent === null ? 'not-applicable' as const
    : percent + Number.EPSILON * 100 >= minimumPercent ? 'passed' as const : 'failed' as const;
  return { imported: true, covered, total, percent, uncovered: input.uncovered.flatMap(({ path, lines }) => ranges(path, lines)),
    unmapped: gaps, gate: { minimumPercent, minimumLines, status } };
}

function ranges(path: string, lines: readonly number[]): { path: string; first: number; last: number }[] {
  const merged: { path: string; first: number; last: number }[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const last = merged.at(-1);
    if (last && line <= last.last + 1) last.last = Math.max(last.last, line);
    else merged.push({ path, first: line, last: line });
  }
  return merged;
}

/** The operations that read the host's coverage input, which their stored records name as the external port `lcov`. */
function coverageImporters({ appliedConfig }: Report): ReadonlySet<unknown> {
  const records: unknown[] = Array.isArray(appliedConfig.operations) ? appliedConfig.operations : [];
  return new Set(records.flatMap(record => isRecord(record) && isRecord(record.inputs)
    && Object.values(record.inputs).some(input => isRecord(input) && input.external === 'lcov') ? [record.key] : []));
}

/** Failures on the head only leave the check unmeasured. Failures on both sides, and skipped large files, are notes. */
function diagnose({ base, head, changes }: ReviewInputs): { unmeasured: ReviewReason[]; notes: ReviewReason[] } {
  const changed = new Set(changes.files.flatMap(file => file.path === null ? [] : [file.path]));
  const failing = (diagnostic: Diagnostic) => diagnostic.state === 'failed' || diagnostic.state === 'blocked';
  const failedOnBase = new Set(base.diagnostics.filter(failing).map(({ operation }) => operation));
  const coverageImports = coverageImporters(head);
  const unmeasured: ReviewReason[] = [];
  const notes: ReviewReason[] = [];
  const brokenPaths = new Set(head.diagnostics.filter(item => item.state === 'failed' && item.path !== undefined).map(item => item.path));
  // An operation blocked by a failure on the same file adds nothing to that failure.
  const reported = head.diagnostics.filter(item => item.state !== 'blocked' || item.path === undefined || !brokenPaths.has(item.path));
  for (const diagnostic of reported) {
    const reason = { operation: diagnostic.operation, ...diagnostic.path === undefined ? {} : { path: diagnostic.path },
      message: diagnostic.message };
    if (diagnostic.operation === 'source/claims') {
      if (diagnostic.path !== undefined && changed.has(diagnostic.path)) notes.push(reason);
    } else if (hostOperations.has(diagnostic.operation) || coverageImports.has(diagnostic.operation) || !failing(diagnostic)) {
      continue;
    } else if (failedOnBase.has(diagnostic.operation) && (diagnostic.path === undefined || !changed.has(diagnostic.path))) {
      notes.push(reason);
    } else {
      unmeasured.push(reason);
    }
  }
  return { unmeasured, notes };
}
