import { javascriptType, typescriptType } from '../../../core/model/file-types.js';
import { isRecord } from '../../../core/model/plugin-data.js';
import { legacySyntaxPlugin } from './inspection-context.js';
import { canonicalMetricId, definitions } from '../../../core/model/measurement.js';
import { lcovLines } from '../../../core/model/line-coverage.js';
import type { Report } from '../validation/report.js';
import { comparePaths } from '../../../core/model/snapshot.js';
import { fileMetrics } from './file-metrics.js';
import { inspectionContext } from './inspection-context.js';
import { isLanguageDisplay } from '../../../core/model/language.js';
import type { LanguageLookup } from '../../../core/model/language.js';
import type { ComplexFunction } from '../wire/public-history-model.js';
import { componentFiles } from './components.js';
import type { Component } from './components.js';

import type { InspectionAsset, InspectionDetails, ProfileLanguage, ProfileSettings } from '../wire/inspection-details-model.js';

export interface InspectionOptions {
  readonly components?: readonly Component[];
  readonly languages?: LanguageLookup;
}

export function inspectionAsset(report: Report, options?: InspectionOptions): InspectionAsset {
  return { schema: 'urn:repometry:schema:viewer-inspection:1', sha: report.subject.id,
    context: inspectionContext(report), inspection: inspectionDetails(report, options) };
}

export function inspectionDetails(report: Report, { components = [], languages }: InspectionOptions = {}): InspectionDetails {
  const files = fileMetrics(report, languages);
  const display = files.languages?.map(item => {
    const syntax = languages?.syntax?.(item.id);
    return syntax === undefined ? item : { ...item, syntax };
  });
  const metrics = display === undefined ? files : { ...files, languages: display };
  const lineCoverage = report.pluginData?.products[lcovLines.id]?.[0]?.value;
  const profile = profileSettings(report.appliedConfig);
  const ruleCatalog = report.pluginData?.rules.flatMap(({ plugin, rules }) => rules.map(rule => ({
    source: plugin, kind: 'check' as const, rule: rule.id, category: rule.category,
    ...(rule.description === undefined ? {} : { title: rule.description }),
    ...(rule.defaults?.limit === undefined ? {} : { limit: rule.defaults.limit }),
    ...(rule.defaults?.cost === undefined ? {} : { minutesPerExcess: rule.defaults.cost }),
  })));
  return { metrics, functions: complexFunctions(report), diagnostics: report.diagnostics, findings: report.findings,
    components: components.length ? componentFiles(components, metrics) : undefined,
    ...(lcovLines.accepts(lineCoverage) ? { lineCoverage } : {}),
    ...(profile ? { profile: { ...profile, ...(ruleCatalog?.length ? { ruleCatalog } : {}) } } : {}) };
}

/** The applied configuration, field by field; whatever is missing or malformed is left out rather than guessed. */
export function profileSettings(applied: unknown): ProfileSettings | undefined {
  if (!isRecord(applied)) return undefined;
  const source = isRecord(applied.source) ? applied.source : {};
  const maintainability = isRecord(applied.maintainability) ? applied.maintainability : {};
  const rules = isRecord(maintainability.structuralRules) ? Object.entries(maintainability.structuralRules).flatMap(([rule, value]) =>
    isRecord(value) && finite(value.limit) && finite(value.minutesPerExcess)
      ? [{ plugin: 'maintainability', rule, limit: value.limit, minutesPerExcess: value.minutesPerExcess }] : []) : [];
  const duplication = maintainability.duplication;
  const model = maintainability.debtModel;
  const churn = applied.churn;
  const plugins = Array.isArray(applied.plugins) ? applied.plugins.filter(isRecord) : [];
  const languages = profileLanguages(plugins, new Set(strings(source.extensions)));
  return {
    id: typeof applied.profile === 'string' ? applied.profile : null,
    ...(languages.length ? { languages } : {}),
    excludedPaths: [...new Set([...strings(source.defaultExclusions), ...strings(source.excludedPaths), ...strings(source.generatedExcluded)])],
    excludedDirectories: strings(source.excludedDirectories),
    rules,
    duplication: isRecord(duplication) && finite(duplication.minCodeLines) && finite(duplication.minNodes) && finite(duplication.minutesPerRepeatedLine)
      ? { minCodeLines: duplication.minCodeLines, minNodes: duplication.minNodes, minutesPerRepeatedLine: duplication.minutesPerRepeatedLine } : null,
    debtModel: isRecord(model) && typeof model.name === 'string' && finite(model.scale) && finite(model.exponent) && finite(model.minutesPerPersonMonth)
      ? { name: model.name, scale: model.scale, exponent: model.exponent, minutesPerPersonMonth: model.minutesPerPersonMonth } : null,
    churn: isRecord(churn) && finite(churn.lookbackDays) && finite(churn.maxCommits) ? { lookbackDays: churn.lookbackDays, maxCommits: churn.maxCommits } : null,
    ignore: Array.isArray(applied.findingIgnore) ? applied.findingIgnore.flatMap(entry => isRecord(entry) ? [Object.fromEntries(
      (['tool', 'rule', 'path', 'reason'] as const).flatMap(key => typeof entry[key] === 'string' ? [[key, entry[key]]] : []))] : []) : [],
    analyzers: plugins.flatMap(({ id, version, tools }) => typeof id === 'string' && typeof version === 'string'
      ? [{ id, version, tools: isRecord(tools)
        ? Object.fromEntries(Object.entries(tools).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {} }] : []),
  };
}

function profileLanguages(plugins: readonly Record<string, unknown>[], recordedExtensions: ReadonlySet<string>): ProfileLanguage[] {
  const recorded = plugins.flatMap(({ id: plugin, providesLanguages, unavailableReason }) => {
    if (typeof plugin !== 'string' || !Array.isArray(providesLanguages)) return [];
    return providesLanguages.flatMap(language => isRecord(language) && isLanguageDisplay(language)
      ? [{ plugin, id: language.id, label: language.label, extensions: strings(language.extensions), globs: strings(language.globs),
        ...(typeof unavailableReason === 'string' ? { unavailableReason } : {}) }]
      : []);
  });
  if (recorded.length) return recorded;
  return [javascriptType, typescriptType].flatMap(({ id, label, extensions }) => {
    const selected = extensions.filter(ext => recordedExtensions.has(ext));
    return selected.length ? [{ plugin: legacySyntaxPlugin, id, label, extensions: selected, globs: [] }] : [];
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function complexFunctions(report: Report): readonly ComplexFunction[] {
  const functions: ComplexFunction[] = [];
  for (const row of report.measurements) {
    if (canonicalMetricId(row.definition) === definitions.complexity && row.target === 'function' && row.path !== undefined && row.value !== null) {
      functions.push({ name: row.name ?? '(anonymous)', path: row.path, line: row.line ?? null, complexity: row.value });
    }
  }
  return functions.sort((left, right) => right.complexity - left.complexity
    || comparePaths(left.path, right.path) || (left.line ?? 0) - (right.line ?? 0));
}
