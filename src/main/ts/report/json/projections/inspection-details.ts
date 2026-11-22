import { definitions } from '../../../core/model/measurement.js';
import type { Report } from '../validation/report.js';
import { comparePaths } from '../../../core/model/snapshot.js';
import { fileMetrics } from './file-metrics.js';
import { inspectionHistory } from './inspection-context.js';
import type { InspectionContext } from './inspection-context.js';
import type { ComplexFunction } from '../wire/public-history-model.js';
import { componentFiles } from './components.js';
import type { Component } from './components.js';

import type { InspectionAsset, InspectionDetails, ProfileSettings } from '../wire/inspection-details-model.js';
export type { DetailsBundle, InspectionAsset, InspectionDetails, ProfileSettings } from '../wire/inspection-details-model.js';

export function inspectionAsset(report: Report, components: readonly Component[] | undefined,
  context = inspectionHistory([report])[report.subject.id]): InspectionAsset {
  return { schema: 'urn:repometry:schema:viewer-inspection:1', sha: report.subject.id,
    context, inspection: inspectionDetails(report, components) };
}

export function inspectionDetails(report: Report, components: readonly Component[] = []): InspectionDetails {
  const metrics = fileMetrics(report);
  const profile = profileSettings(report.appliedConfig);
  const ruleCatalog = report.pluginData?.rules.flatMap(({ plugin, rules }) => rules.map(rule => ({
    source: plugin, kind: 'check' as const, rule: rule.id, category: rule.category,
    ...(rule.description === undefined ? {} : { title: rule.description }),
    ...(rule.defaults?.limit === undefined ? {} : { limit: rule.defaults.limit }),
    ...(rule.defaults?.cost === undefined ? {} : { minutesPerExcess: rule.defaults.cost }),
  })));
  return { metrics, functions: complexFunctions(report), diagnostics: report.diagnostics, findings: report.findings,
    components: components.length ? componentFiles(components, metrics) : undefined,
    ...(profile ? { profile: { ...profile, ...(ruleCatalog?.length ? { ruleCatalog } : {}) } } : {}) };
}

/** The applied configuration, field by field; whatever is missing or malformed is left out rather than guessed. */
export function profileSettings(applied: unknown): ProfileSettings | undefined {
  if (!record(applied)) return undefined;
  const source = record(applied.source) ? applied.source : {};
  const maintainability = record(applied.maintainability) ? applied.maintainability : {};
  const rules = record(maintainability.structuralRules) ? Object.entries(maintainability.structuralRules).flatMap(([rule, value]) =>
    record(value) && finite(value.limit) && finite(value.minutesPerExcess)
      ? [{ plugin: 'maintainability', rule, limit: value.limit, minutesPerExcess: value.minutesPerExcess }] : []) : [];
  const duplication = maintainability.duplication;
  const model = maintainability.debtModel;
  const churn = applied.churn;
  return {
    id: typeof applied.profile === 'string' ? applied.profile : null,
    extensions: strings(source.extensions),
    excludedPaths: [...new Set([...strings(source.defaultExclusions), ...strings(source.excludedPaths), ...strings(source.generatedExcluded)])],
    excludedDirectories: strings(source.excludedDirectories),
    rules,
    duplication: record(duplication) && finite(duplication.minCodeLines) && finite(duplication.minNodes) && finite(duplication.minutesPerRepeatedLine)
      ? { minCodeLines: duplication.minCodeLines, minNodes: duplication.minNodes, minutesPerRepeatedLine: duplication.minutesPerRepeatedLine } : null,
    debtModel: record(model) && typeof model.name === 'string' && finite(model.scale) && finite(model.exponent) && finite(model.minutesPerPersonMonth)
      ? { name: model.name, scale: model.scale, exponent: model.exponent, minutesPerPersonMonth: model.minutesPerPersonMonth } : null,
    churn: record(churn) && finite(churn.lookbackDays) && finite(churn.maxCommits) ? { lookbackDays: churn.lookbackDays, maxCommits: churn.maxCommits } : null,
    ignore: Array.isArray(applied.findingIgnore) ? applied.findingIgnore.flatMap(entry => record(entry) ? [Object.fromEntries(
      (['tool', 'rule', 'path', 'reason'] as const).flatMap(key => typeof entry[key] === 'string' ? [[key, entry[key]]] : []))] : []) : [],
    analyzers: Array.isArray(applied.plugins) ? applied.plugins.flatMap(plugin => record(plugin) && typeof plugin.id === 'string' && typeof plugin.version === 'string'
      ? [{ id: plugin.id, version: plugin.version, tools: record(plugin.tools)
        ? Object.fromEntries(Object.entries(plugin.tools).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {} }] : []) : [],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (row.definition === definitions.complexity && row.target === 'function' && row.path !== undefined && row.value !== null) {
      functions.push({ name: row.name ?? '(anonymous)', path: row.path, line: row.line ?? null, complexity: row.value });
    }
  }
  return functions.sort((left, right) => right.complexity - left.complexity
    || comparePaths(left.path, right.path) || (left.line ?? 0) - (right.line ?? 0));
}
