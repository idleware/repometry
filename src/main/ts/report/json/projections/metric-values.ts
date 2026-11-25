import type { MetricDescriptor, MetricValues } from '../wire/summary-model.js';
import type { Measurement } from '../../../core/model/measurement.js';
import type { StructureMeasure } from '../../../core/model/code-structure.js';
import { canonicalMetricId, definitions } from '../../../core/model/measurement.js';
import type { Report } from '../../../core/model/report.js';

const structureMetricIds: Partial<Record<StructureMeasure, string>> = {
  functions: definitions.functions, cyclomaticComplexity: definitions.complexity,
  cognitiveComplexity: definitions.cognitiveComplexity, classes: definitions.classes,
  commentLines: definitions.comments, codeLines: definitions.codeLines, duplication: definitions.duplicatedLines,
};

export function metricProjection(report: Report) {
  const metadata = report.pluginData;
  if (!metadata?.metrics.length) return undefined;
  const measured = new Set(metadata.measured.map(canonicalMetricId));
  const metrics = metadata.metrics.map(canonicalMetricDescriptor).filter(metric => measured.has(metric.id));
  if (metrics.length === 0) return undefined;
  const rows = new Map<string, Measurement[]>();
  for (const row of report.measurements) {
    const id = canonicalMetricId(row.definition);
    const existing = rows.get(id);
    if (existing) existing.push(row);
    else rows.set(id, [row]);
  }

  const unavailable = new Map<string, Set<string>>();
  for (const file of metadata.inventory ?? []) {
    for (const id of unavailableStructureMetrics(file)) {
      let files = unavailable.get(id);
      if (!files) unavailable.set(id, files = new Set());
      files.add(file.path);
    }
  }

  function isAvailable(id: string, path?: string, directory = false): boolean {
    const files = unavailable.get(id);
    if (!files) return true;
    if (path === undefined || (directory && path === '')) return false;
    if (!directory) return !files.has(path);
    for (const file of files) if (file.startsWith(path + '/')) return false;
    return true;
  }

  function values(path?: string, directory = false): MetricValues {
    const result: Record<number, number | null> = {};
    for (const [index, metric] of metrics.entries()) {
      if (path !== undefined && metric.scope === 'repository') continue;
      const rowValues = (id: string) => rows.get(id) ?? [];
      let value: number | null;
      if (!isAvailable(metric.id, path, directory)) {
        value = null;
      } else if (metric.ratio) {
        const numerator = rollup(rowValues(metric.ratio.of), 'sum', path, directory);
        const denominator = rollup(rowValues(metric.ratio.over), 'sum', path, directory);
        value = denominator && numerator !== null ? numerator / denominator : null;
      } else {
        value = rollup(rowValues(metric.id), metric.aggregate, path, directory);
      }
      if (path === undefined || value !== 0) result[index] = value;
    }
    return result;
  }

  const privateMetrics = metadata.privateMetrics?.map(canonicalMetricId).filter(id => measured.has(id));
  return { catalog: metrics, privateMetrics: privateMetrics?.length ? privateMetrics : undefined, values, isAvailable };
}

export function unavailableStructureMetrics({ analysed, unmeasured = [] }:
  { readonly analysed: boolean; readonly unmeasured?: readonly StructureMeasure[] }): string[] {
  const metrics = unmeasured.flatMap(measure => structureMetricIds[measure] ?? []);
  if (!analysed && unmeasured.length) metrics.push(definitions.lines);
  return metrics;
}

export function canonicalMetricDescriptor(metric: MetricDescriptor): MetricDescriptor {
  const id = canonicalMetricId(metric.id);
  if (!metric.ratio) return metric.id === id ? metric : { ...metric, id };
  const { of, over } = metric.ratio;
  const ratio = { of: canonicalMetricId(of), over: canonicalMetricId(over) };
  return metric.id === id && ratio.of === of && ratio.over === over ? metric : { ...metric, id, ratio };
}

function rollup(rows: readonly Measurement[], aggregate: MetricDescriptor['aggregate'], path: string | undefined, directory: boolean): number | null {
  if (path === undefined) {
    const explicit = rows.find(row => row.target === 'repository');
    if (explicit) return explicit.value;
  }
  const candidates = rows.filter(row => row.path !== undefined && (path === undefined || (directory
    ? path === '' || row.path.startsWith(path + '/') : row.path === path)));
  // A file-level measurement already represents the function rows for that file.
  const fileTotals = new Set(candidates.filter(row => row.target === 'file').map(row => row.path));
  const selected = candidates.filter(row => row.target === 'file' || !fileTotals.has(row.path));
  if (aggregate === 'none') return path !== undefined && !directory && selected.length === 1 ? selected[0]!.value : null;
  const values = selected.flatMap(row => row.value === null ? [] : [row.value]);
  if (values.length === 0) return selected.length === 0 && aggregate === 'sum' ? 0 : null;
  return aggregate === 'sum' ? values.reduce((sum, value) => sum + value, 0) : values.reduce((max, value) => Math.max(max, value));
}
