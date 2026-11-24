import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../engine/plugin.js';
import { canonicalMetricId, definitions } from '../model/measurement.js';
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
  const rows = report.measurements.filter(row => row.target === target && canonicalMetricId(row.definition) === metric.definition);
  const partial = report.scope.parsed < report.scope.files || hasDiagnostic(report, metric.operation) || hasParserDiagnostic(report);
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

function hasParserDiagnostic(report: Report): boolean {
  const references = parserReferences(report);
  if (references.size === 0) return hasDiagnostic(report, 'babel-syntax/parse');
  const operations = new Set(references.values());
  return report.diagnostics.some(({ path, operation }) => path === undefined
    ? operations.has(operation) : references.get(path) === operation);
}

function parserReferences(report: Report): ReadonlyMap<string, string> {
  return new Map((report.pluginData?.inventory ?? []).flatMap(({ path, provider }) => provider === undefined ? [] : [[path, provider]]));
}

function sourceScope(report: Report) {
  const { source, profile } = report.appliedConfig;
  if (!isRecord(source)) return null;
  const paths = orderedStrings(source.excludedPaths === undefined && profile === 'js-ts/v1' ? [] : source.excludedPaths);
  const defaults = orderedStrings(source.defaultExclusions ?? []);
  const directories = orderedStrings(source.excludedDirectories);
  const extensions = orderedStrings(source.extensions);
  const globs = orderedStrings(source.globs ?? []);
  const excludedOutput = source.excludedOutput;
  if (!paths || !defaults || !directories || !extensions || !globs || (excludedOutput !== null && typeof excludedOutput !== 'string')) return null;
  return { kind: report.subject.kind, paths: orderedStrings([...paths, ...defaults]), directories, extensions, globs, excludedOutput,
    generatedSourcePolicy: source.generatedSourcePolicy ?? null };
}

function orderedStrings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) return null;
  return [...new Set(value as string[])].sort(comparePaths);
}

function method(report: Report, metric: Metric) {
  const definition = report.definitions[metric.definition] ?? Object.entries(report.definitions)
    .find(([id]) => canonicalMetricId(id) === metric.definition)?.[1];
  if (typeof definition !== 'string') return null;
  if (metric.definition !== definitions.coverage) {
    const details = structureMethod(report, metric.operation);
    return details === null ? null : { definition, ...details };
  }
  const { plugins, operations, coverage: settings } = report.appliedConfig;
  const toolchain = recordedEntries(plugins, 'id', ['lcov']);
  const bindings = recordedEntries(operations, 'key', [metric.operation]);
  if (!toolchain || !bindings || !isRecord(settings) || typeof settings.merge !== 'string') return null;
  const { inputDigest, inputDigests, pathBase, ...importSettings } = settings;
  return { definition, toolchain, bindings, settings: importSettings };
}

function structureMethod(report: Report, operation: string) {
  const { plugins, operations, parser } = report.appliedConfig;
  if (!Array.isArray(operations)) return null;
  const scopes = new Set(parserReferences(report).values());
  const candidates = operations.filter(isRecord).filter(entry => entry.key === operation);
  const bindings: Record<string, unknown>[] = [];
  const providerKeys = new Set<string>();
  for (const candidate of candidates) {
    const port = isRecord(candidate.inputs) ? candidate.inputs.syntax : undefined;
    if (!isRecord(port)) return null;
    const provider = typeof candidate.syntaxProvider === 'string' ? candidate.syntaxProvider : port.operation;
    if (typeof provider !== 'string' || !provider.includes('/')) return null;
    if (scopes.size && !scopes.has(provider)) continue;
    providerKeys.add(provider);
    bindings.push(candidate);
  }
  if (providerKeys.size === 0 || [...scopes].some(provider => !providerKeys.has(provider))) return null;
  const providerBindings = recordedEntries(operations, 'key', [...providerKeys].sort(comparePaths));
  const pluginIds = [...new Set([operation, ...providerKeys].map(key => key.slice(0, key.indexOf('/'))))].sort(comparePaths);
  const toolchain = recordedEntries(plugins, 'id', pluginIds);
  if (!providerBindings || !toolchain) return null;
  // The original reports carried the Babel configuration at report level.
  const configured = toolchain.map(({ id, version, api, tools, settings }) => ({
    id, version, api, tools, settings: id === 'babel-syntax' && isRecord(parser) ? parser : settings ?? null,
  }));
  return { toolchain: configured, bindings: [...providerBindings, ...bindings.sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b)))] };
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
