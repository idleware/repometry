import type { MetricDescriptor, MetricValues } from '../wire/summary-model.js';
import type { Measurement } from '../../../core/model/measurement.js';
import type { Report } from '../../../core/model/report.js';

export function metricProjection(report: Report) {
  const metadata = report.pluginData;
  if (!metadata?.metrics.length) return undefined;
  const measured = new Set(metadata.measured);
  const metrics = metadata.metrics.filter(metric => measured.has(metric.id));
  if (metrics.length === 0) return undefined;
  const rows = new Map<string, Measurement[]>();
  for (const row of report.measurements) {
    const existing = rows.get(row.definition);
    if (existing) existing.push(row);
    else rows.set(row.definition, [row]);
  }

  function values(path?: string, directory = false): MetricValues {
    const result: Record<number, number | null> = {};
    for (const [index, metric] of metrics.entries()) {
      if (path !== undefined && metric.scope === 'repository') continue;
      const rowValues = (id: string) => rows.get(id) ?? [];
      let value: number | null;
      if (metric.ratio) {
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

  const privateMetrics = metadata.privateMetrics?.filter(id => measured.has(id));
  return { catalog: metrics, privateMetrics: privateMetrics?.length ? privateMetrics : undefined, values };
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
