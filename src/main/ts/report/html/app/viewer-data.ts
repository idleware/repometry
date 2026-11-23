import { unpackJson } from '../../json/wire/compact-json.js';
import { summarySchema } from '../../json/wire/summary-model.js';
import { compareHistoryEntries, historySchema } from '../../json/wire/public-history-model.js';
import type { DetailsBundle, InspectionAsset } from '../../json/wire/inspection-details-model.js';
import type { InspectionContext } from '../../json/wire/inspection-context-model.js';
import type { PublicHistory, PublicHistoryEntry, QualityHistory } from '../../json/wire/public-history-model.js';
import type { InspectionCounts, MetricDescriptor, RepositorySummary } from '../../json/wire/summary-model.js';
import { sourceLocator } from './viewer-source.js';
import type { SourceLocator } from './viewer-source.js';

export interface ViewerData {
  readonly reports: readonly PublicHistoryEntry[];
  readonly quality: QualityHistory['reports'];
  readonly context: Record<string, InspectionContext>;
  readonly counts?: Record<string, InspectionCounts | undefined>;
  readonly pullReviewCount?: number;
  /** The branch whose first-parent history the commits are, when the configuration names it. */
  readonly branch?: string;
  /** The metrics the history's plugins declare; each commit's values are indexed by it. */
  readonly metrics?: readonly MetricDescriptor[];
  /** Where file sources come from, when the export names a place. */
  readonly sources?: SourceLocator;
  loadDetails(sha: string): Promise<InspectionAsset | null>;
}

const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class ViewerSummaryChanged extends Error {
  constructor() {
    super('The repository summary changed');
    this.name = 'ViewerSummaryChanged';
  }
}

export async function loadViewerData(mode: string | undefined): Promise<ViewerData> {
  const summary = await readSummary();
  if (!summary) return legacyViewerData(mode);
  const counts = Object.fromEntries(summary.commits.map(commit => [commit.sha, commit.counts]));
  const details = new Map(summary.commits.map(commit => [commit.sha, commit.detail]));
  return {
    reports: summary.commits,
    quality: Object.fromEntries(summary.commits.map(commit => [commit.sha, commit.quality])),
    context: Object.fromEntries(summary.commits.map(commit => [commit.sha, {
      exclusions: null, boundary: commit.profileBoundary ?? null, security: commit.counts?.security,
    }])),
    counts,
    pullReviewCount: summary.pullReviewCount,
    ...(Array.isArray(summary.metrics) ? { metrics: summary.metrics } : {}),
    ...(() => {
      const sources = sourceLocator(summary.sources);
      return sources ? { sources } : {};
    })(),
    ...(typeof summary.source?.branch === 'string' && summary.source.branch.trim() ? { branch: summary.source.branch.trim() } : {}),
    async loadDetails(sha) {
      const path = details.get(sha);
      if (path === undefined) return null;
      const asset = await readInspection(path, sha, mode);
      if (asset) return asset;
      const next = await readSummary('reload').catch(() => null);
      if (!next) return null;
      if (next.commits.find(commit => commit.sha === sha)?.detail !== path) throw new ViewerSummaryChanged();
      return readInspection(path, sha, mode);
    },
  };
}

async function readSummary(cache?: RequestCache): Promise<RepositorySummary | null> {
  const response = await fetch('./summary.json', { cache });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not load the repository summary');
  const data = await response.json() as RepositorySummary;
  if (data?.schema !== summarySchema || !Array.isArray(data.commits)
    || data.commits.some(commit => !shaPattern.test(commit.sha) || !commit.quality)) throw new Error('Unsupported repository summary');
  return data;
}

async function readInspection(path: string, sha: string, mode: string | undefined): Promise<InspectionAsset | null> {
  const prefix = `${mode === 'local' ? 'inspection' : 'details'}/${sha}-`;
  const allowed = path.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(path.slice(prefix.length));
  if (!allowed) return null;
  try {
    const asset = unpackJson(await readOptional<unknown>(`./${path}`)) as InspectionAsset | null;
    return asset?.schema === 'urn:repometry:schema:viewer-inspection:1' && asset.sha === sha ? asset : null;
  } catch {
    return null;
  }
}

async function legacyViewerData(mode: string | undefined): Promise<ViewerData> {
  const [history, quality, saved, localContext] = await Promise.all([
    readOptional<PublicHistory>('./history.json'),
    readOptional<QualityHistory>('./quality-history.json'),
    mode === 'local' ? null : readOptional<DetailsBundle>('./details.json'),
    mode === 'local' ? readOptional<Record<string, InspectionContext>>('./inspection-context.json') : null,
  ]);
  if (history?.schema !== historySchema || !Array.isArray(history.reports)) throw new Error('Unsupported history format');
  const bundle = saved?.schema === 'urn:repometry:schema:viewer-details:1' ? saved : null;
  const context = localContext ?? bundle?.context ?? {};
  const reports = [...history.reports].sort(compareHistoryEntries);
  return {
    reports, context, quality: quality?.schema === 'urn:repometry:schema:quality-history:1' ? quality.reports : {},
    async loadDetails(sha) {
      if (!shaPattern.test(sha)) return null;
      const inspection = mode === 'local'
        ? await readOptional<InspectionAsset['inspection']>(`./details/${sha}.json`)
        : bundle?.inspections[sha];
      return inspection ? { schema: 'urn:repometry:schema:viewer-inspection:1', sha, context: context[sha], inspection } : null;
    },
  };
}

async function readOptional<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path);
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  }
}
