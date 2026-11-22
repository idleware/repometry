import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../engine/plugin.js';
import { definitions } from '../model/measurement.js';
import type { Measurement } from '../model/measurement.js';
import type { Report } from '../model/report.js';
import { comparePaths } from '../model/snapshot.js';

import { comparisonSchema } from '../model/comparison.js';
import type { ComparisonSubject, InspectionComparison, MetricComparison, Observation } from '../model/comparison.js';
export { comparisonSchema } from '../model/comparison.js';
export type { InspectionComparison } from '../model/comparison.js';

const metrics = {
  physicalLines: { definition: definitions.lines, operation: 'structure/size' },
  functions: { definition: definitions.functions, operation: 'structure/size' },
  maxCyclomaticComplexity: { definition: definitions.complexity, operation: 'structure/complexity' },
  lineCoverage: { definition: definitions.coverage, operation: 'lcov/import' },
} as const;

type Metric = typeof metrics[keyof typeof metrics];
export function compareInspections(baseline: Report, current: Report): InspectionComparison {
  const scopes = [sourceScope(baseline), sourceScope(current)];
  const scopeReason = scopes.some(scope => scope === null) ? 'source-scope-unknown'
    : isDeepStrictEqual(scopes[0], scopes[1]) ? null : 'source-scope-changed';
  const compare = (metric: Metric) => compareMetric(metric, baseline, current, scopeReason);
  return { schema: comparisonSchema, baseline: subject(baseline), current: subject(current), metrics: {
    physicalLines: compare(metrics.physicalLines), functions: compare(metrics.functions),
    maxCyclomaticComplexity: compare(metrics.maxCyclomaticComplexity), lineCoverage: compare(metrics.lineCoverage),
  } };
}

function compareMetric(metric: Metric, baseline: Report, current: Report,
  scopeReason: 'source-scope-unknown' | 'source-scope-changed' | null): MetricComparison {
  const before = observe(baseline, metric);
  const after = observe(current, metric);
  const unit = metric.definition === definitions.coverage ? 'percent' : 'count';
  const base = { definition: metric.definition, unit, baseline: before, current: after, delta: null } as const;
  if (before.status !== 'complete' || after.status !== 'complete' || before.value === null || after.value === null) {
    return { ...base, status: 'unavailable', reason: 'observations-unavailable' };
  }
  if (scopeReason) {
    return { ...base, status: scopeReason === 'source-scope-unknown' ? 'unavailable' : 'incompatible', reason: scopeReason };
  }
  const beforeMethod = method(baseline, metric);
  const afterMethod = method(current, metric);
  if (!beforeMethod || !afterMethod) return { ...base, status: 'unavailable', reason: 'method-unknown' };
  if (!isDeepStrictEqual(beforeMethod, afterMethod)) return { ...base, status: 'incompatible', reason: 'method-changed' };
  return { ...base, status: 'comparable', reason: null, delta: after.value - before.value };
}

function observe(report: Report, metric: Metric): Observation {
  if (metric.definition === definitions.coverage) return observeCoverage(report);
  const maximum = metric.definition === definitions.complexity;
  const target = maximum ? 'function' : 'file';
  const rows = report.measurements.filter(row => row.definition === metric.definition && row.target === target);
  const partial = report.scope.parsed < report.scope.files || hasDiagnostic(report, metric.operation, 'babel-syntax/parse');
  const expected = maximum ? fileCount(report.measurements, definitions.functions, report.scope.files) : report.scope.files;
  const value = integerAggregate(rows, maximum);
  if (partial) return { status: 'partial', value };
  if (expected === null || rows.length !== expected || (!maximum && !distinctPaths(rows))) {
    return { status: 'unavailable', value: null };
  }
  if (expected === 0) return { status: 'not-applicable', value: null };
  return { status: value === null ? 'unavailable' : 'complete', value };
}

export function observeCoverage(report: Report): Observation {
  const rows = report.measurements.filter(row => row.definition === definitions.coverage && row.target === 'repository');
  const row = rows.length === 1 ? rows[0] : undefined;
  const partial = hasDiagnostic(report, 'lcov/import');
  if (row?.covered === undefined || row.total === undefined) return { status: partial ? 'partial' : 'unavailable', value: null };
  const value = row.total > 0 ? 100 * row.covered / row.total : null;
  return { status: partial ? 'partial' : value === null ? 'not-applicable' : 'complete', value, covered: row.covered, total: row.total };
}

function fileCount(measurements: readonly Measurement[], definition: string, expected: number): number | null {
  const rows = measurements.filter(row => row.definition === definition && row.target === 'file');
  if (rows.length !== expected || !distinctPaths(rows)) return null;
  return rows.length === 0 ? 0 : integerAggregate(rows, false);
}

function distinctPaths(rows: readonly Measurement[]): boolean {
  const paths = new Set(rows.map(row => row.path));
  return !paths.has(undefined) && paths.size === rows.length;
}

function integerAggregate(rows: readonly Measurement[], maximum: boolean): number | null {
  if (rows.length === 0) return null;
  let result = 0;
  for (const { value } of rows) {
    if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
    result = maximum ? Math.max(result, value) : result + value;
  }
  return Number.isSafeInteger(result) ? result : null;
}

function hasDiagnostic(report: Report, ...operations: string[]): boolean {
  return report.diagnostics.some(item => operations.includes(item.operation));
}

function sourceScope(report: Report) {
  const { source, profile } = report.appliedConfig;
  if (!isRecord(source)) return null;
  const paths = orderedStrings(source.excludedPaths === undefined && profile === 'js-ts/v1' ? [] : source.excludedPaths);
  const defaults = orderedStrings(source.defaultExclusions ?? []);
  const directories = orderedStrings(source.excludedDirectories);
  const extensions = orderedStrings(source.extensions);
  const excludedOutput = source.excludedOutput;
  if (!paths || !defaults || !directories || !extensions || (excludedOutput !== null && typeof excludedOutput !== 'string')) return null;
  return { kind: report.subject.kind, paths: orderedStrings([...paths, ...defaults]), directories, extensions, excludedOutput,
    generatedSourcePolicy: source.generatedSourcePolicy ?? null };
}

function orderedStrings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) return null;
  return [...new Set(value as string[])].sort(comparePaths);
}

function method(report: Report, metric: Metric) {
  const definition = report.definitions[metric.definition];
  const { plugins, operations, parser, coverage } = report.appliedConfig;
  const importsCoverage = metric.definition === definitions.coverage;
  const pluginIds = importsCoverage ? ['lcov'] : ['babel-syntax', 'structure'];
  const operationKeys = importsCoverage ? [metric.operation] : ['babel-syntax/parse', metric.operation];
  const toolchain = recordedEntries(plugins, 'id', pluginIds);
  const bindings = recordedEntries(operations, 'key', operationKeys);
  const settings = importsCoverage ? coverage : parser;
  if (typeof definition !== 'string' || !toolchain || !bindings || !isRecord(settings)) return null;
  if (importsCoverage && typeof settings.merge !== 'string') return null;
  if (!importsCoverage) return { definition, toolchain, bindings, settings };
  const { inputDigest, inputDigests, pathBase, ...importSettings } = settings;
  return { definition, toolchain, bindings, settings: importSettings };
}

function recordedEntries(value: unknown, key: 'id' | 'key', names: readonly string[]) {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isRecord);
  const matches = names.map(name => entries.filter(entry => entry[key] === name));
  if (matches.some(group => group.length !== 1)) return null;
  const recorded = matches.map(group => group[0]!);
  const valid = key === 'id'
    ? recorded.every(entry => typeof entry.version === 'string' && typeof entry.api === 'string' && isRecord(entry.tools))
    : recorded.every(entry => isRecord(entry.inputs));
  return valid ? recorded : null;
}

function subject({ subject, generatedAt, status, scope }: Report): ComparisonSubject {
  return { subject, generatedAt, status, scope };
}
