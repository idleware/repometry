import { collator, count, parentPath, percent } from './viewer-dom.js';
import type { HotspotMetric, Metrics, Navigation } from './viewer-inspection.js';
import { localValue } from './viewer-inspection.js';
import { duration, pluginSpec } from './viewer-metrics.js';

/** How a file's or a folder's figures read: ratios as percentages, a dash for what was not measured. */

export function coverageRatio(entry: Metrics): number | null {
  const coverage = entry.lineCoverage;
  return coverage && coverage.total > 0 ? coverage.covered / coverage.total : null;
}

export function coverageText(entry: Metrics): string {
  return ratioText(coverageRatio(entry));
}

export function coverageContext(entry: Metrics): string | undefined {
  const value = entry.lineCoverage;
  return value && value.total > 0 ? `${count(value.covered)} of ${count(value.total)} lines` : undefined;
}

export function duplicationRatio(entry: Metrics): number | null {
  const value = entry.quality?.duplication;
  return value && value.codeLines > 0 ? value.duplicatedLines / value.codeLines : null;
}

export function duplicationText(entry: Metrics): string {
  return ratioText(duplicationRatio(entry));
}

export function duplicationContext(entry: Metrics): string | undefined {
  const value = entry.quality?.duplication;
  return value && value.codeLines > 0 ? `${count(value.duplicatedLines)} of ${count(value.codeLines)} code lines` : undefined;
}

function ratioText(value: number | null): string {
  return value === null ? '—' : percent(value);
}

/** Remediation time, or a dash where maintainability was not measured. */
export function effortText(minutes: number | null | undefined): string {
  return minutes == null ? '—' : duration(minutes);
}

const builtinScores: Record<string, (entry: Metrics) => number | null | undefined> = {
  // A file measured without functions has nothing to score; one with no record was not measured.
  complexity: entry => entry.complexity && (entry.complexity.maximum ?? 0),
  cognitive: entry => entry.quality?.cognitiveComplexity,
  duplication: entry => entry.quality?.duplication?.duplicatedLines,
  churn: entry => entry.quality?.churn,
  missedLines: entry => entry.lineCoverage && entry.lineCoverage.total > 0 ? entry.lineCoverage.total - entry.lineCoverage.covered : null,
};

/** What a file scores on the metric the code map and the ranking show; null where it was not measured. */
export function hotspotScore(entry: Metrics, metric: HotspotMetric): number | null {
  const plugin = pluginSpec(metric);
  if (plugin) return localValue(entry, plugin);
  // A name that is neither a plugin's nor one of the rankings reads as uncovered lines, the last of them.
  return (builtinScores[metric] ?? builtinScores.missedLines!)(entry) ?? null;
}

/** The top of a ranking's bars: its highest measured score, and 1 where none is above zero. */
export function scorePeak(scores: readonly (number | null)[]): number {
  return scores.reduce<number>((max, score) => score === null ? max : Math.max(max, score), 0) || 1;
}

/** Orders two entries by a column, unmeasured last whichever way the column sorts, and by path between equals. */
export function compareEntries(a: Metrics, b: Metrics, measurement: (row: Metrics) => string | number | null, ascending: boolean): number {
  const left = measurement(a);
  const right = measurement(b);
  if (left === null || right === null) return Number(left === null) - Number(right === null) || collator.compare(a.path, b.path);
  const difference = typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
  return (ascending ? difference : -difference) || collator.compare(a.path, b.path);
}

export function fileHref(navigation: Pick<Navigation, 'href'>, file: string): string {
  return navigation.href('metrics', { directory: parentPath(file), file });
}
