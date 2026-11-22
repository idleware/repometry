import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../engine/plugin.js';
import { isSensitiveFinding } from '../model/finding.js';
import type { Finding } from '../model/finding.js';
import { pullReviewSchema } from '../model/pull-review.js';
import type { PullReview } from '../model/pull-review.js';
import type { Report } from '../model/report.js';
import { findingImportMethods } from '../model/scanner-import.js';
import { compareInspections, observeCoverage } from './compare.js';
import type { DiffCoverageReport } from './diff-coverage.js';

export interface ReviewOptions {
  readonly number?: number;
  readonly minimumLines?: number;
  readonly minimumPercent?: number;
  readonly maxCoverageDrop?: number;
  readonly maxNewIssues?: number;
}

export interface ReviewPorts {
  readHead(id: string): Promise<Report | null>;
  readBase(id: string): Promise<Report | null>;
  readRevisions(): Promise<{ head: string; base: string; mergeBase(): Promise<string> }>;
  measureChanged?(): Promise<{ report: DiffCoverageReport; uncovered: PullReview['diff']['uncovered'] }>;
}

export async function executeReview(options: ReviewOptions, ports: ReviewPorts): Promise<PullReview> {
  if (!ports.measureChanged && options.minimumPercent !== undefined) throw new Error('Minimum diff coverage requires --lcov');
  if (ports.measureChanged) {
    const { report, uncovered } = await ports.measureChanged();
    const [head, base] = await Promise.all([ports.readHead(report.head), ports.readBase(report.requestedBase)]);
    return projectReview(options, report, uncovered, head, base);
  }
  const revisions = await ports.readRevisions();
  const [head, base, mergeBase] = await Promise.all([
    ports.readHead(revisions.head), ports.readBase(revisions.base), revisions.mergeBase(),
  ]);
  return projectReview(options, {
    generatedAt: new Date().toISOString(), requestedBase: revisions.base, base: mergeBase, head: revisions.head,
    status: 'unavailable', covered: 0, total: 0, percent: null, files: [], gaps: [], decision: null,
  }, [], head, base);
}

type ChangedLines = Pick<DiffCoverageReport, 'generatedAt' | 'requestedBase' | 'base' | 'head' | 'covered' | 'total' | 'percent' | 'files' | 'gaps' | 'decision'>
  & { readonly status: PullReview['diff']['status']; readonly appliedConfig?: DiffCoverageReport['appliedConfig'] };

export function projectReview(request: ReviewOptions,
  diff: ChangedLines, uncovered: PullReview['diff']['uncovered'], head: Report | null, base: Report | null): PullReview {
  const minimumLines = request.minimumLines ?? 0;
  if (request.number !== undefined && (!Number.isSafeInteger(request.number) || request.number < 1)) {
    throw new Error('Pull request number must be a positive integer');
  }
  if (!Number.isSafeInteger(minimumLines) || minimumLines < 0) throw new Error('Minimum diff lines must be a non-negative integer');
  if (request.maxNewIssues !== undefined && (!Number.isSafeInteger(request.maxNewIssues) || request.maxNewIssues < 0)) {
    throw new Error('Maximum new issues must be a non-negative integer');
  }
  if (request.maxCoverageDrop !== undefined && (!Number.isFinite(request.maxCoverageDrop) || request.maxCoverageDrop < 0 || request.maxCoverageDrop > 100)) {
    throw new Error('Maximum coverage drop must be a number from 0 to 100');
  }
  if (request.minimumLines !== undefined && diff.decision === null) {
    throw new Error('Minimum diff lines requires a minimum diff coverage percentage');
  }
  const { status, covered, total, percent, files, gaps, decision } = diff;
  const config = diff.appliedConfig;
  const source = config?.source;
  const lcov = config?.lcov;
  const excludedPaths = isRecord(source) && Array.isArray(source.excludedPaths)
    && source.excludedPaths.every((path: unknown) => typeof path === 'string') ? source.excludedPaths as string[] : null;
  const coverageInputDigest = isRecord(lcov) && typeof lcov.inputDigest === 'string' ? lcov.inputDigest : null;
  const gate = decision && {
    minimumPercent: decision.minimumPercent,
    minimumLines,
    status: total < minimumLines && status !== 'partial' ? 'not-applicable' as const : decision.status,
  };
  return { schema: pullReviewSchema, number: request.number ?? null, generatedAt: diff.generatedAt,
    base: diff.requestedBase, mergeBase: diff.base, head: diff.head,
    coverage: coverageImpact(head, base, diff, request.maxCoverageDrop),
    diff: { status, covered, total, percent, files, gaps, excludedPaths, coverageInputDigest, uncovered, gate },
    findings: findingImpact(head, base, request.maxNewIssues),
  };
}

export function reviewExitCode(review: PullReview): number {
  const decisions = [review.diff.gate, review.coverage.gate, review.findings.gate].map(gate => gate?.status);
  if (review.diff.status === 'partial' || decisions.includes('indeterminate')
    || (review.diff.status === 'unavailable' && review.findings.added === null && review.coverage.delta === null)) return 2;
  return decisions.includes('failed') ? 3 : 0;
}

function coverageImpact(head: Report | null, base: Report | null, diff: ChangedLines,
  maxDrop: number | undefined): PullReview['coverage'] {
  const method = head?.appliedConfig.coverage;
  const input = diff.appliedConfig?.lcov;
  const usesHeadCoverage = isRecord(method) && isRecord(input) && method.inputDigest === input.inputDigest;
  const mismatch = head !== null && diff.appliedConfig !== undefined && !usesHeadCoverage;
  const comparison = base && head && !mismatch ? compareInspections(base, head).metrics.lineCoverage : null;
  const delta = comparison?.delta ?? null;
  const gate = maxDrop === undefined ? null : { maxDrop,
    status: delta === null ? 'indeterminate' as const : delta + maxDrop < -Number.EPSILON * 100 ? 'failed' as const : 'passed' as const };
  return {
    base: base ? observeCoverage(base) : null,
    head: head && !mismatch ? observeCoverage(head) : null,
    delta, reason: comparison ? comparison.reason : mismatch ? 'head-coverage-changed' : 'reports-unavailable', gate,
  };
}

function findingImpact(head: Report | null, base: Report | null, maximum: number | undefined): PullReview['findings'] {
  const { added, reason } = comparableFindings(head, base, false);
  const quality = added ?? comparableFindings(head, base, true).added;
  const qualityCount = quality ? quality.filter(finding => !isSensitiveFinding(finding.category)).length : null;
  return { added, qualityCount, reason, gate: maximum === undefined ? null : { maximum,
    status: qualityCount === null ? 'indeterminate' : qualityCount > maximum ? 'failed' : 'passed' } };
}

function comparableFindings(head: Report | null, base: Report | null, qualityOnly: boolean) {
  let reason: PullReview['findings']['reason'] = null;
  let added: readonly Finding[] | null = null;
  if (!head || !base) reason = 'reports-unavailable';
  else if (!head.findings || !base.findings) reason = 'findings-unavailable';
  else if (incompleteAnalysis(head, qualityOnly) || incompleteAnalysis(base, qualityOnly)) reason = 'partial-inspection';
  else if (!isDeepStrictEqual(findingMethod(head, qualityOnly), findingMethod(base, qualityOnly))) reason = 'analysis-changed';
  else added = newFindings(base.findings, head.findings);
  return { added, reason };
}

function incompleteAnalysis(report: Report, qualityOnly: boolean): boolean {
  return report.scope.parsed < report.scope.files || report.diagnostics.some(({ operation }) =>
    operation !== 'lcov/import' && operation !== 'git/churn'
      && !(qualityOnly && /^findings\/(security|dependency|secret|infrastructure)\//.test(operation)));
}

function newFindings(base: readonly Finding[], head: readonly Finding[]): readonly Finding[] {
  const remaining = new Map<string, number>();
  const key = ({ category, path, tool, rule, message }: Finding) => JSON.stringify([category, path, tool, rule, message]);
  for (const finding of base) {
    const id = key(finding);
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  return head.filter(finding => {
    const id = key(finding);
    const count = remaining.get(id) ?? 0;
    if (count === 0) return true;
    remaining.set(id, count - 1);
    return false;
  });
}

function findingMethod(report: Report, qualityOnly: boolean) {
  const { coverage, findingImports, churn, churnWindow, plugins, operations, ...settings } = report.appliedConfig;
  const exclude = (entries: unknown, key: string, value: string) =>
    Array.isArray(entries) ? entries.filter(entry => !isRecord(entry) || entry[key] !== value) : entries;
  const imported = findingImportMethods(findingImports).filter(({ category }) => !qualityOnly || !isSensitiveFinding(category));
  return { ...settings, imported, plugins: exclude(plugins, 'id', 'lcov'), operations: exclude(operations, 'key', 'lcov/import') };
}
