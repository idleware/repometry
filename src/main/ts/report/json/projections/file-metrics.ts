import { isRecord } from '../../../core/engine/plugin.js';
import { canonicalMetricId, definitions } from '../../../core/model/measurement.js';
import type { Report } from '../validation/report.js';
import type { ChurnWindow } from '../../../core/model/churn.js';
import { comparePaths } from '../../../core/model/snapshot.js';
import { metricProjection } from './metric-values.js';

import { fileMetricsSchema } from '../wire/file-metrics-model.js';
import type { Complexity, DirectoryMetrics, FileMetricsReport, Maintainability, Metrics, Quality } from '../wire/file-metrics-model.js';
export { fileMetricsSchema } from '../wire/file-metrics-model.js';
export type { FileMetricsReport } from '../wire/file-metrics-model.js';

export function fileMetrics(report: Report): FileMetricsReport {
  const byPath = new Map<string, Metrics>();
  const duplicatedLines = new Map<string, number>();
  const pluginMetrics = metricProjection(report);
  const languages: { id: string; label?: string; color?: string; analysed: boolean }[] = [];
  const languageCatalog = new Map(report.pluginData?.languages?.map(language => [language.id, language]));
  const languageIndexes = new Map<string, number>();
  function file(path: string): Metrics {
    const existing = byPath.get(path);
    if (existing) return existing;
    const metrics = emptyMetrics(path);
    byPath.set(path, metrics);
    return metrics;
  }

  for (const { path, lines, bytes, language, analysed, provider } of report.pluginData?.inventory ?? []) {
    let index = languageIndexes.get(language);
    if (index === undefined) {
      index = languages.length;
      languageIndexes.set(language, index);
      languages.push({ id: language, ...languageCatalog.get(language), analysed });
    } else if (analysed) {
      languages[index]!.analysed = true;
    }
    const entry = file(path);
    entry.lines = lines;
    if (bytes !== undefined) entry.bytes = bytes;
    entry.language = index;
    entry.analysed = analysed;
    if (provider !== undefined) entry.provider = provider;
  }

  for (const row of report.measurements) {
    if (!row.path) continue;
    const id = canonicalMetricId(row.definition);
    if (pluginMetrics) file(row.path);
    if (row.target === 'file' && id === definitions.coverage && row.covered !== undefined && row.total !== undefined) {
      file(row.path).lineCoverage = { covered: row.covered, total: row.total };
    }
    if (row.value === null || !Number.isSafeInteger(row.value) || row.value < 0) continue;
    if (row.target === 'file' && id === definitions.lines) file(row.path).lines = row.value;
    if (row.target === 'file' && id === definitions.functions) file(row.path).functions = row.value;
    if (row.target === 'file') {
      switch (id) {
        case definitions.codeLines: quality(file(row.path)).codeLines = row.value; break;
        case definitions.comments: quality(file(row.path)).commentLines = row.value; break;
        case definitions.classes: quality(file(row.path)).classes = row.value; break;
        case definitions.cognitiveComplexity: quality(file(row.path)).cognitiveComplexity = row.value; break;
        case definitions.churn: quality(file(row.path)).churn = row.value; break;
        case definitions.duplicatedLines: duplicatedLines.set(row.path, row.value); break;
      }
    }
    if (row.target === 'function' && id === definitions.complexity) {
      const target = file(row.path);
      target.complexity = addComplexity(target.complexity, { sum: row.value, maximum: row.value, measuredFunctions: 1 });
    }
  }

  for (const [path, duplicateCount] of duplicatedLines) {
    const entry = byPath.get(path);
    const codeLines = entry?.quality?.codeLines;
    if (entry && codeLines !== undefined && duplicateCount <= codeLines) {
      quality(entry).duplication = { duplicatedLines: duplicateCount, codeLines };
    }
  }
  addFileFindings(byPath, report.findings);

  let unassignedDiagnostics = 0;
  for (const diagnostic of report.diagnostics) {
    const { path, operation } = diagnostic;
    const target = path === undefined ? undefined
      : operation === 'babel-syntax/parse' || operation.startsWith('structure/') ? file(path) : byPath.get(path);
    if (target) target.diagnosticCount++;
    else unassignedDiagnostics++;
  }

  const files = [...byPath.values()].sort(byName);
  const directories = new Map<string, DirectoryMetrics>();
  for (const entry of files) {
    if (pluginMetrics && entry.analysed !== false) {
      const values = pluginMetrics.values(entry.path);
      if (Object.keys(values).length) entry.values = values;
    }
    if (entry.functions === 0 && !entry.complexity) {
      entry.complexity = { sum: 0, maximum: null, measuredFunctions: 0 };
    }
    let path = entry.path;
    do {
      path = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      let directory = directories.get(path);
      if (!directory) {
        directory = { ...emptyMetrics(path), files: 0, sizeMeasuredFiles: 0, coverageMeasuredFiles: 0 };
        directories.set(path, directory);
      }
      addFile(directory, entry);
    } while (path !== '');
  }
  if (pluginMetrics) {
    for (const entry of directories.values()) {
      const values = pluginMetrics.values(entry.path, true);
      if (Object.keys(values).length) entry.values = values;
    }
  }
  const complexity = files.filter(entry => entry.complexity?.maximum != null)
    .sort((left, right) => right.complexity!.maximum! - left.complexity!.maximum!
      || right.complexity!.sum - left.complexity!.sum || byName(left, right));
  const coverage = files.filter(entry => missedLines(entry) > 0)
    .sort((left, right) => missedLines(right) - missedLines(left) || byName(left, right));
  const cognitive = ranked(files, entry => entry.quality?.cognitiveComplexity);
  const duplication = ranked(files, entry => entry.quality?.duplication?.duplicatedLines);
  const churn = ranked(files, entry => entry.quality?.churn);
  const churnWindow = readChurnWindow(report.appliedConfig);

  return { schema: fileMetricsSchema, subject: report.subject, generatedAt: report.generatedAt,
    status: report.status, scope: report.scope, files, directories: [...directories.values()].sort(byName), unassignedDiagnostics,
    ...(pluginMetrics === undefined ? {} : { catalog: pluginMetrics.catalog }),
    ...(languages.length === 0 ? {} : { languages }),
    ...(churnWindow === undefined ? {} : { churnWindow }),
    hotspots: { complexity: complexity.map(entry => entry.path), missedLines: coverage.map(entry => entry.path),
      ...(cognitive === undefined ? {} : { cognitive }), ...(duplication === undefined ? {} : { duplication }),
      ...(churn === undefined ? {} : { churn }) } };
}

function addFileFindings(byPath: ReadonlyMap<string, Metrics>, findings: Report['findings']): void {
  if (findings === undefined) return;
  for (const entry of byPath.values()) {
    if (entry.quality?.duplication) entry.quality.maintainability = { smells: 0, effortMinutes: 0 };
  }
  for (const finding of findings) {
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

function addFile(directory: DirectoryMetrics, file: Metrics): void {
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

function missedLines(entry: Metrics): number {
  return entry.lineCoverage ? entry.lineCoverage.total - entry.lineCoverage.covered : 0;
}
