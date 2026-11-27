import type { LineChanges } from '../model/changes.js';
import { isSensitiveFinding } from '../model/finding.js';
import type { Finding } from '../model/finding.js';
import type { IssueEffect, ReviewedIssue } from '../model/pull-review.js';

export type { IssueEffect, ReviewedIssue } from '../model/pull-review.js';
export type { SourceLines } from './review-scope.js';
import { pairFindings } from './review-match.js';
import { compare, inScope, placed, reviewSide } from './review-scope.js';
import type { ReviewSide, SourceLines } from './review-scope.js';

const order: Readonly<Record<IssueEffect, number>> = { new: 0, worsened: 1, improved: 2, touched: 3 };

/**
 * Pairs base and head findings that are the same issue, and keeps the pairs on the changed lines of either side.
 * A head finding without a pair is new; a base finding without one was fixed.
 */
export function classifyIssues(base: readonly Finding[], head: readonly Finding[], changes: LineChanges,
  sources: { readonly base: SourceLines; readonly head: SourceLines }): readonly ReviewedIssue[] {
  const before = reviewSide(changes, 'base', sources.base);
  const after = reviewSide(changes, 'head', sources.head);
  const issues = pairFindings(base, head, changes, { base: before, head: after })
    .filter(([from, to]) => (from !== undefined && inScope(from, before)) || (to !== undefined && inScope(to, after)))
    .map(([from, to]) => review(from, to, before, after));
  return issues.sort((left, right) => Number(isSensitiveFinding(right.finding.category)) - Number(isSensitiveFinding(left.finding.category))
    || order[left.effect] - order[right.effect] || compare(left.finding.path ?? '', right.finding.path ?? '')
    || (left.finding.line ?? 0) - (right.finding.line ?? 0));
}

export function debtEffect(issues: readonly ReviewedIssue[]): { readonly added: number; readonly removed: number } {
  return issues.reduce((total, { debtMinutes }) => debtMinutes > 0 ? { ...total, added: total.added + debtMinutes }
    : { ...total, removed: total.removed - debtMinutes }, { added: 0, removed: 0 });
}

function review(base: Finding | undefined, head: Finding | undefined, before: ReviewSide, after: ReviewSide): ReviewedIssue {
  const effort = (finding: Finding | undefined) => finding?.effortMinutes ?? 0;
  if (!head) return { effect: 'improved', ...placed(base!, before), before: base!.value ?? null, fixed: true, debtMinutes: -effort(base) };
  return { effect: effectOf(base, head), ...placed(head, after), before: base?.value ?? null, fixed: false,
    debtMinutes: effort(head) - effort(base) };
}

function effectOf(base: Finding | undefined, head: Finding): IssueEffect {
  if (!base) return 'new';
  if (head.value === undefined || base.value === undefined || head.value === base.value) return 'touched';
  return head.value > base.value ? 'worsened' : 'improved';
}
