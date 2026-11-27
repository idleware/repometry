import type { LineChanges } from '../model/changes.js';
import type { Finding } from '../model/finding.js';
import { digest } from '../model/snapshot.js';
import { positionMatches } from './review-position.js';
import type { ReviewSide } from './review-scope.js';

/** A base finding and a head finding that are the same issue; one side is absent for a new or a fixed issue. */
export type FindingPair = readonly [base: Finding | undefined, head: Finding | undefined];

/**
 * Pairs the findings of both sides that are the same issue. First by position through the diff, which follows code that
 * moved or was renamed and tells unnamed functions apart. Then by rule, file, anchor and the text of the first line, in
 * line order. Last, an anchor that only one finding on each side still carries, such as a rewritten named function.
 */
export function pairFindings(base: readonly Finding[], head: readonly Finding[], changes: LineChanges,
  sides: { readonly base: ReviewSide; readonly head: ReviewSide }): FindingPair[] {
  const byBase = new Map(changes.files.flatMap(file => file.previous === null ? [] : [[file.previous, file] as const]));
  const headPath = (path: string) => byBase.has(path) ? byBase.get(path)!.path : path;
  const baseLeft = new Set(base);
  const headLeft = new Set(head);
  const pairs: FindingPair[] = [];
  const take = (from: Finding, to: Finding) => {
    if (!baseLeft.has(from) || !headLeft.has(to)) return;
    baseLeft.delete(from);
    headLeft.delete(to);
    pairs.push([from, to]);
  };
  for (const { base: from, head: to } of positionMatches(base, head, byBase, headPath)) take(from, to);
  pairByKey(baseLeft, headLeft, headPath, (finding, path, side) => identity(finding, path, side === 'base' ? sides.base : sides.head), take);
  pairByKey(baseLeft, headLeft, headPath, uniqueAnchor(baseLeft, headLeft, headPath), take);
  return [...pairs, ...[...headLeft].map(finding => [undefined, finding] as const), ...[...baseLeft].map(finding => [finding, undefined] as const)];
}

type KeyOf = (finding: Finding, path: string | undefined, side: 'base' | 'head') => string | undefined;

/** Pairs leftover findings with equal keys, in line order. */
function pairByKey(baseLeft: ReadonlySet<Finding>, headLeft: ReadonlySet<Finding>, headPath: (path: string) => string | null,
  keyOf: KeyOf, take: (from: Finding, to: Finding) => void): void {
  const waiting = new Map<string, Finding[]>();
  for (const finding of inLineOrder(baseLeft)) {
    const path = finding.path === undefined ? undefined : headPath(finding.path);
    const key = path === null ? undefined : keyOf(finding, path, 'base');
    if (key !== undefined) waiting.set(key, [...waiting.get(key) ?? [], finding]);
  }
  for (const finding of inLineOrder(headLeft)) {
    const key = keyOf(finding, finding.path, 'head');
    const match = key === undefined ? undefined : waiting.get(key)?.shift();
    if (match) take(match, finding);
  }
}

/** Keys an anchor that exactly one leftover finding carries on each side; repeated anchors such as `(anonymous)` get none. */
function uniqueAnchor(baseLeft: ReadonlySet<Finding>, headLeft: ReadonlySet<Finding>, headPath: (path: string) => string | null): KeyOf {
  const anchorKey = (finding: Finding, path: string | undefined) =>
    finding.anchor === undefined || finding.category === 'duplication' ? undefined : JSON.stringify([finding.rule, path ?? null, finding.anchor]);
  const counts = new Map<string, number>();
  const count = (key: string | undefined, side: number) => {
    if (key !== undefined) counts.set(`${side}${key}`, (counts.get(`${side}${key}`) ?? 0) + 1);
  };
  for (const finding of baseLeft) count(anchorKey(finding, finding.path === undefined ? undefined : headPath(finding.path) ?? undefined), 0);
  for (const finding of headLeft) count(anchorKey(finding, finding.path), 1);
  return (finding, path) => {
    const key = anchorKey(finding, path);
    return key !== undefined && counts.get(`0${key}`) === 1 && counts.get(`1${key}`) === 1 ? key : undefined;
  };
}

function identity(finding: Finding, path: string | undefined, side: ReviewSide): string {
  if (finding.category === 'duplication' && finding.anchor !== undefined) return JSON.stringify(['duplication', finding.anchor]);
  return JSON.stringify([finding.rule, path ?? null, finding.anchor ?? null, lineHash(finding, side)]);
}

function lineHash(finding: Finding, side: ReviewSide): string {
  const text = finding.path === undefined || finding.line === undefined ? undefined : side.lines.line(finding.path, finding.line);
  return text === undefined ? '(file)' : digest(text.replace(/\s+/g, '')).slice(0, 16);
}

function inLineOrder(findings: Iterable<Finding>): Finding[] {
  return [...findings].sort((left, right) => (left.line ?? 0) - (right.line ?? 0) || (left.endLine ?? 0) - (right.endLine ?? 0));
}

