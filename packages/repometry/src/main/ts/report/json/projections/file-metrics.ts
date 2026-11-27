import { fileTypeId, fileTypes } from '../../../core/model/file-types.js';
import type { LanguageLookup } from '../../../core/model/language.js';
import { isRecord } from '../../../core/engine/plugin.js';
import type { Measurement } from '../../../core/model/measurement.js';
import { canonicalMetricId, definitions } from '../../../core/model/measurement.js';
import { legacySyntaxPlugin } from './inspection-context.js';
import type { Report } from '../validation/report.js';
import type { ChurnWindow } from '../../../core/model/churn.js';
import { comparePaths } from '../../../core/model/snapshot.js';
import { metricProjection } from './metric-values.js';

import { fileMetricsSchema } from '../wire/file-metrics-model.js';
import type { Complexity, DirectoryMetrics, FileMetricsReport, Maintainability, Metrics, Quality } from '../wire/file-metrics-model.js';

export function fileMetrics(report: Report, registry: LanguageLookup = { id: fileTypeId, catalog: [] }): FileMetricsReport {
  const byPath = new Map<string, Metrics>();
  const pluginMetrics = metricProjection(report);
  const languages: { id: string; label?: string; color?: string; analysed: boolean }[] = [];
  const recorded = new Map(report.pluginData?.languages?.map(item => [item.id, item]));
  const languageCatalog = new Map([...fileTypes, ...registry.catalog, ...recorded.values()].map(item => [item.id, item]));
  const languageIndexes = new Map<string, number>();
  function file(path: string): Metrics {
    const existing = byPath.get(path);
    if (existing) return existing;
    const metrics = emptyMetrics(path);
    byPath.set(path, metrics);
    return metrics;
  }

  function languageIndex(id: string, analysed: boolean): number {
    const existing = languageIndexes.get(id);
    if (existing !== undefined) {
      languages[existing]!.analysed ||= analysed;
      return existing;
    }
    const index = languages.length;
    languageIndexes.set(id, index);
    const display = languageCatalog.get(id);
    languages.push({ id, label: display?.label ?? (id === 'other' ? 'Other' : id.toUpperCase()),
      ...(display?.color === undefined ? {} : { color: display.color }), analysed });
    return index;
  }

  for (const { path, lines, bytes, language, analysed, provider } of report.pluginData?.inventory ?? []) {
    const entry = file(path);
    entry.lines = lines;
    if (bytes !== undefined) entry.bytes = bytes;
    entry.language = languageIndex(provider !== undefined || recorded.has(language) ? language : fileTypeId(path, language), analysed);
    entry.analysed = analysed;
    if (provider !== undefined) entry.provider = provider;
  }

  const duplicatedLines = collectMeasurements(report.measurements, file, pluginMetrics !== undefined);
  const skipped = new Set(report.ruleSkips?.map(({ path }) => path));
  addFileQuality(byPath, duplicatedLines, report.findings, skipped);

  let unassignedDiagnostics = 0;
  for (const { path, operation } of report.diagnostics) {
    const target = path === undefined ? undefined
      : operation === `${legacySyntaxPlugin}/parse` || operation.startsWith('structure/') ? file(path) : byPath.get(path);
    if (target) target.diagnosticCount++;
    else unassignedDiagnostics++;
  }

  const files = [...byPath.values()].sort(byName);
  const directories = new Map<string, DirectoryMetrics>();
  for (const entry of files) {
    entry.language ??= languageIndex(registry.id(entry.path),
      entry.lines !== null || entry.lineCoverage !== null || entry.functions !== null);
    if (pluginMetrics && entry.analysed !== false) {
      const values = pluginMetrics.values(entry.path);
      if (Object.keys(values).length) entry.values = values;
    }
    if (entry.functions === 0 && !entry.complexity && pluginMetrics?.isAvailable(definitions.complexity, entry.path) !== false) {
      entry.complexity = { sum: 0, maximum: null, measuredFunctions: 0 };
    }
    rollUpFile(directories, entry);
  }
  if (pluginMetrics) {
    for (const entry of directories.values()) applyDirectoryProjection(entry, pluginMetrics);
  }
  const complexity = files.filter(entry => entry.complexity?.maximum != null)
    .sort((left, right) => right.complexity!.maximum! - left.complexity!.maximum!
      || right.complexity!.sum - left.complexity!.sum || byName(left, right));
  const coverage = ranked(files, ({ lineCoverage }) => lineCoverage && lineCoverage.covered < lineCoverage.total
    ? lineCoverage.total - lineCoverage.covered : undefined) ?? [];
  const cognitive = ranked(files, entry => entry.quality?.cognitiveComplexity);
  const duplication = ranked(files, entry => entry.quality?.duplication?.duplicatedLines);
  const churn = ranked(files, entry => entry.quality?.churn);
  const churnWindow = readChurnWindow(report.appliedConfig);

  return { schema: fileMetricsSchema, subject: report.subject, generatedAt: report.generatedAt,
    status: report.status, scope: report.scope, files, directories: [...directories.values()].sort(byName), unassignedDiagnostics,
    ...(pluginMetrics === undefined ? {} : { catalog: pluginMetrics.catalog }),
    ...(languages.length === 0 ? {} : { languages }),
    ...(churnWindow === undefined ? {} : { churnWindow }),
    hotspots: { complexity: complexity.map(entry => entry.path), missedLines: coverage,
      ...(cognitive === undefined ? {} : { cognitive }), ...(duplication === undefined ? {} : { duplication }),
      ...(churn === undefined ? {} : { churn }) } };
}

const qualityFields = new Map<string, keyof Omit<Quality, 'duplication' | 'maintainability'>>([
  [definitions.codeLines, 'codeLines'], [definitions.comments, 'commentLines'], [definitions.classes, 'classes'],
  [definitions.cognitiveComplexity, 'cognitiveComplexity'], [definitions.churn, 'churn'],
]);

function collectMeasurements(rows: readonly Measurement[], file: (path: string) => Metrics, includeMeasuredFiles: boolean) {
  const duplicated = new Map<string, number>();
  for (const { path, target, value, definition, covered, total } of rows) {
    if (!path) continue;
    if (includeMeasuredFiles) file(path);
    const id = canonicalMetricId(definition);
    if (target === 'file' && id === definitions.coverage && covered !== undefined && total !== undefined) {
      file(path).lineCoverage = { covered, total };
    }
    if (value === null || !Number.isSafeInteger(value) || value < 0) continue;
    if (target === 'file') {
      const field = qualityFields.get(id);
      if (field) quality(file(path))[field] = value;
      else if (id === definitions.lines) file(path).lines = value;
      else if (id === definitions.functions) file(path).functions = value;
      else if (id === definitions.duplicatedLines) duplicated.set(path, value);
    } else if (target === 'function' && id === definitions.complexity) {
      const entry = file(path);
      entry.complexity = addComplexity(entry.complexity, { sum: value, maximum: value, measuredFunctions: 1 });
    }
  }
  return duplicated;
}

function applyDirectoryProjection(entry: DirectoryMetrics, projection: NonNullable<ReturnType<typeof metricProjection>>): void {
  const values = projection.values(entry.path, true);
  if (Object.keys(values).length) entry.values = values;
  const known = (id: string) => projection.isAvailable(id, entry.path, true);
  if (!known(definitions.functions)) entry.functions = null;
  if (!known(definitions.complexity)) entry.complexity = null;
  if (!entry.quality) return;
  for (const [id, field] of qualityFields) if (!known(id)) delete entry.quality[field];
  if (!known(definitions.duplicatedLines) || !known(definitions.codeLines)) delete entry.quality.duplication;
}

function addFileQuality(byPath: ReadonlyMap<string, Metrics>, duplicated: ReadonlyMap<string, number>,
  findings: Report['findings'], skipped: ReadonlySet<string>): void {
  for (const [path, duplicatedLines] of duplicated) {
    const entry = byPath.get(path);
    const codeLines = entry?.quality?.codeLines;
    if (!entry || codeLines === undefined || duplicatedLines > codeLines) continue;
    const result = quality(entry);
    result.duplication = { duplicatedLines, codeLines };
    if (findings !== undefined && !skipped.has(path)) result.maintainability = { smells: 0, effortMinutes: 0 };
  }
  for (const finding of findings ?? []) {
    if (!finding.path || (finding.category !== 'structure' && finding.category !== 'duplication')) continue;
    const observations = byPath.get(finding.path)?.quality;
    if (!observations?.maintainability) continue;
    observations.maintainability = addMaintainability(observations.maintainability, {
      smells: 1, effortMinutes: finding.effortMinutes ?? null,
    });
  }
}

function emptyMetrics(path: string): Metrics {
  return { path, lines: null, functions: null, complexity: null, lineCoverage: null, diagnosticCount: 0 };
}

function byName(left: Metrics, right: Metrics): number {
  return comparePaths(left.path, right.path);
}

function rollUpFile(directories: Map<string, DirectoryMetrics>, file: Metrics): void {
  let path = file.path;
  do {
    path = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    let directory = directories.get(path);
    if (!directory) {
      directory = { ...emptyMetrics(path), files: 0, sizeMeasuredFiles: 0, coverageMeasuredFiles: 0 };
      directories.set(path, directory);
    }
    directory.files++;
    if (file.lines !== null) directory.sizeMeasuredFiles++;
    directory.lines = sumKnown(directory.lines, file.lines);
    if (file.bytes !== undefined) directory.bytes = (directory.bytes ?? 0) + file.bytes;
    directory.functions = sumKnown(directory.functions, file.functions);
    directory.complexity = addComplexity(directory.complexity, file.complexity);
    if (file.lineCoverage) {
      directory.coverageMeasuredFiles++;
      directory.lineCoverage = {
        covered: (directory.lineCoverage?.covered ?? 0) + file.lineCoverage.covered,
        total: (directory.lineCoverage?.total ?? 0) + file.lineCoverage.total,
      };
    }
    directory.diagnosticCount += file.diagnosticCount;
    if (file.quality) addQuality(quality(directory), file.quality);
  } while (path !== '');
}

function quality(entry: Metrics): Quality {
  return entry.quality ??= {};
}

function addQuality(target: Quality, source: Quality): void {
  for (const key of ['codeLines', 'commentLines', 'classes', 'cognitiveComplexity', 'churn'] as const) {
    const value = source[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
  if (source.duplication) {
    target.duplication = {
      duplicatedLines: (target.duplication?.duplicatedLines ?? 0) + source.duplication.duplicatedLines,
      codeLines: (target.duplication?.codeLines ?? 0) + source.duplication.codeLines,
    };
  }
  if (source.maintainability) {
    target.maintainability = addMaintainability(target.maintainability ?? { smells: 0, effortMinutes: 0 }, source.maintainability);
  }
}

function readChurnWindow(config: Report['appliedConfig']): FileMetricsReport['churnWindow'] {
  const { churn, churnWindow } = config;
  if (!isRecord(churn) || !isRecord(churnWindow)) return undefined;
  const { lookbackDays, maxCommits } = churn;
  const { endingAt, commits, shallow, capReached } = churnWindow;
  if (typeof lookbackDays !== 'number' || !Number.isSafeInteger(lookbackDays) || lookbackDays < 1
    || typeof maxCommits !== 'number' || !Number.isSafeInteger(maxCommits) || maxCommits < 1
    || typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits < 0 || commits > maxCommits
    || typeof endingAt !== 'string' || !Number.isFinite(Date.parse(endingAt))
    || typeof shallow !== 'boolean' || typeof capReached !== 'boolean') return undefined;
  return { lookbackDays, maxCommits, endingAt, commits, shallow, capReached };
}

function addMaintainability(left: Maintainability, right: Maintainability): Maintainability {
  return { smells: left.smells + right.smells, effortMinutes: left.effortMinutes === null || right.effortMinutes === null
    ? null : left.effortMinutes + right.effortMinutes };
}

function ranked(files: readonly Metrics[], score: (entry: Metrics) => number | undefined): string[] | undefined {
  const entries = files.flatMap(entry => {
    const value = score(entry);
    return value === undefined ? [] : [{ entry, value }];
  });
  if (entries.length === 0) return undefined;
  return entries.filter(({ value }) => value > 0).sort((left, right) => right.value - left.value || byName(left.entry, right.entry))
    .map(({ entry }) => entry.path);
}

function sumKnown(left: number | null, right: number | null): number | null {
  return right === null ? left : (left ?? 0) + right;
}

function addComplexity(left: Complexity | null, right: Complexity | null): Complexity | null {
  if (!left || !right) return left ?? right;
  const maximum = left.maximum === null ? right.maximum : Math.max(left.maximum, right.maximum ?? left.maximum);
  return { sum: left.sum + right.sum, maximum, measuredFunctions: left.measuredFunctions + right.measuredFunctions };
}
