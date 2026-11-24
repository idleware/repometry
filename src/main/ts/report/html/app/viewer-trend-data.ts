// What the Trends page can show: the series, grouped, that this history measured, and the slice of history in view.
import type { InspectionContext } from '../../json/wire/inspection-context-model.js';
import type { QualitySummary } from '../../json/wire/domain-types.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';
import { isMetric, labelOf, metricLabels, metricValue, pluginMetrics } from './viewer-metrics.js';
import type { Metric } from './viewer-metrics.js';

export type TrendView = Metric | 'debt-changes' | 'diff-coverage';
export type Period = '30' | '100' | 'all';

export interface TrendData {
  readonly reports: readonly PublicHistoryEntry[];
  readonly quality: Record<string, QualitySummary>;
  readonly context: Record<string, InspectionContext> | null;
  readonly compact: boolean;
  /** Link to the Trends page for a commit, keeping or replacing the view and period. */
  readonly link: (sha: string, view?: TrendView, period?: Period) => string;
}

/** The views the viewer draws by hand rather than from one metric's values. */
const ownViews: ReadonlySet<TrendView> = new Set(['debt-changes', 'diff-coverage']);

const ownLabels: Partial<Record<TrendView, string>> = {
  debt: 'Technical debt', 'debt-changes': 'Technical debt changes', 'diff-coverage': 'Changed-line coverage',
};

export function viewLabel(view: TrendView): string {
  return ownLabels[view] ?? labelOf(view as Metric);
}

/** The metric a view reads at a commit; the views drawn by hand read none. */
export function viewMetric(view: TrendView): Metric | null {
  return ownViews.has(view) ? null : view as Metric;
}

const builtinGroups: readonly (readonly [string, readonly TrendView[]])[] = [
  ['Maintainability', ['debt', 'debt-changes', 'duplication', 'cognitive', 'complexity', 'smells']],
  // Branch and function coverage come from the registry, where the coverage report has them.
  ['Coverage', ['coverage', 'branch-coverage' as Metric, 'function-coverage' as Metric, 'diff-coverage']],
  ['Security', ['security']],
  ['Size', ['code-lines', 'files', 'functions', 'classes', 'comments']],
];

/** A view the registry names, not one the viewer draws by hand. */
function pluginKey(view: TrendView): boolean {
  return !ownViews.has(view) && !(view in metricLabels);
}

/**
 * The series list: Repometry's own groups, with other plugins' metrics joining a group they name or one of their own.
 * A registry metric the groups already place keeps its place, and is left out where this history has no such metric.
 */
export function groups(): (readonly [string, readonly TrendView[]])[] {
  const placed = new Set<TrendView>(builtinGroups.flatMap(([, views]) => views));
  const trended = pluginMetrics().filter(spec => spec.trend);
  const keys = new Set(trended.map(spec => spec.key));
  const merged = new Map<string, TrendView[]>(builtinGroups.map(([group, views]) =>
    [group, views.filter(view => !pluginKey(view) || keys.has(view))]));
  for (const spec of trended.filter(spec => !placed.has(spec.key as TrendView))) {
    merged.set(spec.group, [...merged.get(spec.group) ?? [], spec.key as TrendView]);
  }
  return [...merged];
}

export function isTrendView(value: string | null | undefined): value is TrendView {
  if (value === 'debt-changes' || value === 'diff-coverage') return true;
  return isMetric(value) && groups().some(([, views]) => views.includes(value));
}

export function isPeriod(value: string | null | undefined): value is Period {
  return value === '30' || value === '100' || value === 'all';
}

/** A metric's value at a commit, read with the commit's own quality summary and context. */
export function trendValue(data: Pick<TrendData, 'quality' | 'context'>, report: PublicHistoryEntry, metric: Metric): number | null {
  return metricValue(report, metric, data.quality[report.sha], data.context?.[report.sha]);
}

/** Views that have data in this history, in display order; debt changes need remediation times. */
export function availableViews(data: TrendData): TrendView[] {
  const has = (metric: Metric) => data.reports.some(report => trendValue(data, report, metric) !== null);
  return groups().flatMap(([, views]) => views).filter(view => view === 'diff-coverage' || has(view === 'debt-changes' ? 'effort' : view));
}

/** The whole curve by default; only a very long history opens on its last hundred inspections. */
export function defaultPeriod(total: number): Period {
  return total <= 1000 ? 'all' : '100';
}

export interface Window { readonly start: number; readonly end: number }

const windows = new Map<string, Window & { readonly size: number; readonly total: number; readonly head: string | undefined }>();

/** The inspections shown for a period, oldest first, always including the selected one. */
export function windowOf(reports: readonly PublicHistoryEntry[], selected: PublicHistoryEntry, period: Period): PublicHistoryEntry[] {
  const limit = period === 'all' ? reports.length : Number(period);
  const { start, end } = stableWindow(reports, reports.indexOf(selected), limit, 'trends');
  return reports.slice(start, end).reverse();
}

/** Whether the slice shown last still fits: the same size over the same history, and the commit inside it. */
function keeps(previous: (Window & { size: number; total: number; head: string | undefined }) | undefined, index: number,
  shape: { size: number; total: number; head: string | undefined }): previous is Window & { size: number; total: number; head: string | undefined } {
  if (!previous || previous.size !== shape.size || previous.total !== shape.total) return false;
  return previous.head === shape.head && index >= previous.start && index < previous.end;
}

/**
 * The slice of history a chart shows, newest first by index. Picking a commit inside the current slice keeps it, so
 * the axes and scale stay where the eye left them; only a commit outside it moves the slice, which then centres on
 * that commit so its neighbours on both sides are in view. The newest commits are the default slice.
 */
export function stableWindow(reports: readonly PublicHistoryEntry[], index: number, size: number, key: string): Window {
  const shape = { size, total: reports.length, head: reports[0]?.sha };
  const previous = windows.get(key);
  let result: Window;
  if (keeps(previous, index, shape)) result = { start: previous.start, end: previous.end };
  else if (index < size) result = { start: 0, end: Math.min(size, shape.total) };
  else {
    const end = Math.min(shape.total, Math.max(0, index - Math.floor(size / 2)) + size);
    result = { start: Math.max(0, end - size), end };
  }
  windows.set(key, { ...result, ...shape });
  return result;
}

/** Commit time of an inspection, or null for exports made before commit times were recorded. */
export function commitTime(report: PublicHistoryEntry): number | null {
  const time = report.committedAt === undefined ? NaN : Date.parse(report.committedAt);
  return Number.isFinite(time) ? time : null;
}

/**
 * The inspections a time chart can place: when the history has commit times, one without (a root commit has no churn
 * window to read it from) cannot be put on the time axis, so it stays out of the chart and in the table.
 */
export function charted(shown: readonly PublicHistoryEntry[]): PublicHistoryEntry[] {
  const timed = shown.filter(report => commitTime(report) !== null);
  return timed.length ? timed : [...shown];
}
