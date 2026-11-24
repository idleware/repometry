import type { FileMetricsReport } from '../../json/wire/file-metrics-model.js';
import type { InspectionDetails } from '../../json/wire/inspection-details-model.js';
import type { MetricDescriptor } from '../../json/wire/summary-model.js';
import { usePluginMeasures } from './viewer-filter.js';
import { useLanguages } from './viewer-languages.js';
import { catalogIndex, entryValue } from './viewer-metric-registry.js';
import type { MetricSpec, Valued } from './viewer-metric-registry.js';
import { extendCatalog, pluginMetrics } from './viewer-metrics.js';
import type { PluginMetric } from './viewer-metrics.js';

/** The pages that read one inspection: its files, its code map, its findings and its diagnostics. */
export type View = 'metrics' | 'hotspots' | 'diagnostics' | 'issues';
export type Metrics = FileMetricsReport['files'][number];
export type Directory = FileMetricsReport['directories'][number];
export type BuiltinHotspot = keyof FileMetricsReport['hotspots'];
/** What the code map and the ranking measure: one of Repometry's rankings, or another plugin's metric by its key. */
export type HotspotMetric = BuiltinHotspot | PluginMetric;

export interface Navigation {
  readonly directory: string;
  readonly file: string;
  /** The Metrics query and grouping from the URL. */
  readonly query?: string | undefined;
  readonly group?: string | undefined;
  /** A source line to bring into view. */
  readonly line?: number | undefined;
  /** The Issues filters from the URL: finding categories, comma-separated, and a severity. */
  readonly category?: string | undefined;
  readonly level?: string | undefined;
  /** What Hotspots ranks by. */
  readonly rank?: string | undefined;
  /** What an open file's lines show: its findings (the default) or its coverage. */
  readonly layer?: string | undefined;
  /** Source text of a file at this commit; absent where the view cannot load source. */
  readonly source?: ((path: string) => Promise<string | null>) | undefined;
  /** The file's page on its forge, when the export names one. */
  readonly sourcePage?: ((path: string, line?: number) => { readonly href: string; readonly provider: string } | null) | undefined;
  href(view: View, options?: LinkOptions): string;
}

export interface LinkOptions {
  readonly directory?: string;
  readonly file?: string;
  readonly query?: string;
  readonly group?: string;
  readonly line?: number;
  readonly category?: string;
  readonly level?: string;
  readonly rank?: string;
  readonly layer?: string;
}

/** What a reader chose on these pages, kept while the viewer stays open. */
export interface Preferences {
  mode: string;
  sort: number;
  ascending: boolean;
  hotspot: HotspotMetric;
  columns: Map<number, boolean>;
  /** Whether the files no plugin read are listed, or folded into one row at the end. */
  unanalysed: boolean;
}

/** How many rows a page of any list holds. */
export const pageSize = 50;

/** The inspection's own catalog: its file and folder values are indexed by it, not by the history's. */
let local: { readonly catalog: readonly MetricDescriptor[] | undefined; readonly index: ReadonlyMap<string, number> } = { catalog: undefined, index: new Map() };

export function useDetails(details: InspectionDetails): void {
  const catalog = details.metrics.catalog;
  extendCatalog(catalog);
  useLanguages(details.metrics.languages);
  local = { catalog, index: catalogIndex(catalog) };
  usePluginMeasures(pluginMetrics().filter(spec => spec.descriptor.scope === 'file' && measured(spec.descriptor)).map(spec => [spec.key, {
    label: spec.label, percent: spec.descriptor.unit === 'ratio', minutes: spec.descriptor.unit === 'minutes',
    read: (entry: Metrics) => localValue(entry, spec),
  }] as const));
}

export function localCatalog(): readonly MetricDescriptor[] | undefined {
  return local.catalog;
}

/** A file's or a folder's value of a registry metric, read through this inspection's catalog. */
export function localValue(entry: Valued, spec: MetricSpec): number | null {
  return entryValue(local.index, entry, spec);
}

/** Whether this inspection ran the metric: a ratio ran where its denominator did. */
export function measured(descriptor: MetricDescriptor): boolean {
  return local.index.has(descriptor.ratio?.over ?? descriptor.id);
}

/** Registry metrics of files that this inspection ran. */
export function measuredFileMetrics(): MetricSpec[] {
  return pluginMetrics().filter(spec => spec.descriptor.scope === 'file' && measured(spec.descriptor));
}

/** Coverage kinds beside line coverage (branches, functions), where the coverage report has them. */
export function coverageKinds(): MetricSpec[] {
  return pluginMetrics().filter(spec => spec.plugin === 'repometry' && spec.group === 'Coverage' && spec.descriptor.unit === 'ratio'
    && spec.descriptor.scope === 'file');
}
