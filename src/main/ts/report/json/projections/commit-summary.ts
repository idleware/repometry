import { canonicalMetricId, definitions } from '../../../core/model/measurement.js';
import { qualitySummary } from '../../../core/model/quality-summary.js';
import { securityCounts } from './security-summary.js';
import { compareHistoryEntries } from '../wire/public-history-model.js';
import type { PublicHistoryEntry } from '../wire/public-history-model.js';
import { inspectionProfileDigest } from './inspection-context.js';
import { reportRevision } from '../validation/report.js';
import type { Report } from '../validation/report.js';
import { canonicalMetricDescriptor, metricProjection } from './metric-values.js';

import { summarySchema } from '../wire/summary-model.js';
import type { CommitSummary, MetricDescriptor, RepositorySummary } from '../wire/summary-model.js';

export function commitSummary(report: Report): CommitSummary {
  const history = historyEntry(report);
  const profileDigest = inspectionProfileDigest(report);
  const metrics = metricProjection(report);
  const security = securityCounts(report);
  return {
    ...history,
    ...(report.commit === undefined ? {} : { subject: report.commit.subject, author: report.commit.author }),
    revision: reportRevision(report),
    ...(profileDigest === undefined ? {} : { profileDigest }),
    quality: qualitySummary(report),
    counts: {
      findingCount: report.findings?.length ?? 0,
      diagnosticCount: report.diagnostics.length,
      componentCount: 0,
      hasCoverage: history.lineCoverage !== null,
      ...(security ? { security } : {}),
    },
    ...(metrics === undefined ? {} : { metrics: metrics.catalog, values: metrics.values(),
      ...(metrics.privateMetrics === undefined ? {} : { privateMetrics: metrics.privateMetrics }) }),
  };
}

export function orderSummaries(rows: readonly CommitSummary[]): CommitSummary[] {
  return [...rows].sort(compareHistoryEntries);
}

export type CommitMetadata = Pick<PublicHistoryEntry, 'subject' | 'author' | 'tags' | 'committedAt'>;
export type ReadCommitMetadata = (revisions: readonly string[]) => Promise<ReadonlyMap<string, CommitMetadata>>;

/** Values recorded at analysis win; Git fills in missing metadata and adds current tag names. */
export async function withCommitMetadata(rows: readonly CommitSummary[], read?: ReadCommitMetadata): Promise<readonly CommitSummary[]> {
  if (!read || !rows.length) return rows;
  const metadata = await read(rows.map(row => row.sha));
  return rows.map(row => {
    const found = metadata.get(row.sha);
    if (found === undefined) return row;
    const { committedAt: gitTime, ...gitFields } = found;
    const { sha, generatedAt, committedAt = gitTime, ...rest } = row;
    return { ...gitFields, sha, generatedAt, ...(committedAt === undefined ? {} : { committedAt }), ...rest,
      ...(gitFields.tags === undefined ? {} : { tags: gitFields.tags }) };
  });
}

export function expandSummaryCatalog(summary: RepositorySummary): CommitSummary[] {
  return orderSummaries(summary.commits).map(row => summary.metrics === undefined || row.values === undefined ? row
    : { ...row, metrics: summary.metrics, ...(summary.privateMetrics === undefined ? {} : { privateMetrics: summary.privateMetrics }) });
}

export function repositorySummary(rows: readonly CommitSummary[], pullReviewCount?: number, includePrivateMetrics = true): RepositorySummary {
  const ordered = orderSummaries(rows);
  const privateMetrics = new Set(ordered.flatMap(row => row.privateMetrics ?? []).map(canonicalMetricId));
  const catalog = new Map<string, MetricDescriptor>();
  for (const row of ordered) {
    for (const descriptor of row.metrics ?? []) {
      const metric = canonicalMetricDescriptor(descriptor);
      if ((includePrivateMetrics || !privateMetrics.has(metric.id)) && !catalog.has(metric.id)) catalog.set(metric.id, metric);
    }
  }
  const metrics = [...catalog.values()];
  const positions = new Map(metrics.map(({ id }, index) => [id, index]));
  const commits = ordered.map(({ metrics: local, values, privateMetrics: _private, ...row }) => {
    if (!local || !values) return row;
    const mapped: Record<number, number | null> = {};
    for (const [index, value] of Object.entries(values)) {
      const id = local[Number(index)]?.id;
      const canonical = id === undefined ? undefined : canonicalMetricId(id);
      const position = canonical === undefined ? undefined : positions.get(canonical);
      if (position !== undefined && (canonical === id || !Object.hasOwn(mapped, position))) mapped[position] = value;
    }
    return Object.keys(mapped).length ? { ...row, values: mapped } : row;
  });
  return {
    schema: summarySchema,
    commits,
    ...(metrics.length ? { metrics } : {}),
    ...(includePrivateMetrics && privateMetrics.size ? { privateMetrics: [...privateMetrics] } : {}),
    ...(pullReviewCount === undefined ? {} : { pullReviewCount }),
  };
}

export function historyEntry(report: Report): PublicHistoryEntry {
  let lines: number | null = null;
  let functions: number | null = null;
  let maxComplexity: number | null = null;
  let lineCoverage: PublicHistoryEntry['lineCoverage'] = null;
  for (const item of report.measurements) {
    if (item.value === null || item.value < 0) continue;
    if (item.target === 'file' && Number.isSafeInteger(item.value)) {
      if (item.definition === definitions.lines) lines = (lines ?? 0) + item.value;
      if (item.definition === definitions.functions) functions = (functions ?? 0) + item.value;
    }
    if (item.target === 'function' && canonicalMetricId(item.definition) === definitions.complexity && Number.isSafeInteger(item.value)) {
      maxComplexity = Math.max(maxComplexity ?? 0, item.value);
    }
    if (item.target === 'repository' && item.definition === definitions.coverage && item.covered !== undefined && item.total !== undefined && item.total > 0) {
      lineCoverage = { covered: item.covered, total: item.total };
    }
  }
  const committedAt = Date.parse(report.committedAt ?? '');
  const generatedAt = Date.parse(report.generatedAt);
  return { sha: report.subject.id, generatedAt: Number.isFinite(generatedAt) ? new Date(generatedAt).toISOString() : '',
    ...(Number.isFinite(committedAt) ? { committedAt: new Date(committedAt).toISOString() } : {}), status: report.status,
    files: report.scope.files, parsed: report.scope.parsed, lines, functions, maxComplexity, lineCoverage };
}
