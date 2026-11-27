import { structureMeasures } from '../core/model/code-structure.js';
import type { NativeLanguagePlugin } from './native-language-plugins.js';
import { definitions } from '../core/model/measurement.js';
import { debtModel } from '../core/model/quality-summary.js';
import { reportSchema } from '../core/model/report.js';
import type { Report } from '../core/model/report.js';
import { comparePaths, digest, sourceDirectoriesExcluded, textLineCount } from '../core/model/snapshot.js';
import type { SourceSnapshot } from '../core/model/source.js';
import { defaultSourceExclusions, generatedSourcePolicy } from '../core/profile/exclusions.js';
import { duplicationSettings, structuralRules } from '../core/profile/maintainability.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import type { AnalysisResults } from './analysis-results.js';
import type { AnalysisSources } from './phases.js';
import { fileTypeId } from '../core/model/file-types.js';

export const analysisProfile = 'repository/v3';

const measurementDefinitions = {
  [definitions.lines]: 'Physical lines including blank lines and comments. A final line terminator does not add a line.',
  [definitions.functions]: 'Functions, methods and function literals recognized by the language provider, including nested functions.',
  [definitions.complexity]: 'One plus decision points in the function body. The language provider defines its decision rules and column units. Nested functions are measured separately.',
  [definitions.coverage]: 'Distinct covered lines divided by the distinct lines listed in LCOV DA records, filtered to code where classifications are available. Hit counts are summed across records. A zero denominator has no ratio.',
  [definitions.codeLines]: 'Nonblank physical lines after removing comment spans and the interpreter directive. A line containing both code and a comment counts as code.',
  [definitions.comments]: 'Physical lines containing only a comment or interpreter directive.',
  [definitions.classes]: 'Class declarations and expressions recognized by the language provider.',
  [definitions.cognitiveComplexity]: 'Flow breaks plus nesting weight and logical operator sequences. Nested functions are measured separately. File complexity sums functions and module-level flow breaks.',
  [definitions.duplicatedLines]: 'Distinct code lines inside repeated Babel syntax subtrees, including original and repeated occurrences. Identifier and literal spellings are ignored for similar-code matches.',
};

export function assembleAnalysisReport(input: AnalysisInput, sources: AnalysisSources, results: AnalysisResults): Report {
  const pluginData = results.pluginData();
  const { snapshot } = input;
  const fileCount = sources.sourceFiles.length + sources.unavailableFiles.size;
  return {
    schema: reportSchema,
    subject: snapshot.subject,
    generatedAt: new Date().toISOString(),
    appliedConfig: appliedConfiguration(input, sources, results),
    definitions: { ...Object.fromEntries((pluginData?.metrics ?? []).map(metric => [metric.id, metric.description ?? metric.label])),
      ...measurementDefinitions },
    scope: { files: fileCount, parsed: results.parsed.size },
    status: inspectionStatus(fileCount > 0, results),
    measurements: results.measurements,
    diagnostics: results.diagnostics,
    findings: results.findings,
    ...(results.ruleSkips.length === 0 ? {} : { ruleSkips: results.ruleSkips }),
    ...(pluginData === undefined ? {} : { pluginData: { ...pluginData, languages: sources.languages.catalog,
      inventory: reportInventory(snapshot, sources, results) } }),
  };
}

function appliedConfiguration({ snapshot, excludedOutput, excludedPaths = [], coverage }: AnalysisInput,
  { languages, plugins }: AnalysisSources, results: AnalysisResults): Report['appliedConfig'] {
  const securityScanners = results.securityScanners(plugins);
  return {
    profile: analysisProfile, mode: snapshot.subject.kind,
    source: { extensions: languages.extensions, ...(languages.globs.length ? { globs: languages.globs } : {}),
      excludedDirectories: sourceDirectoriesExcluded, excludedOutput, excludedPaths,
      defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
    parser: languages.providers[0]!.plugin.settings,
    maintainability: { structuralRules, duplication: duplicationSettings, debtModel, remediation: 'nonoverlapping-complexity/v1' },
    coverage: coverage === undefined ? null : { inputDigest: digest(coverage.text), pathBase: coverage.sourceRoot,
      merge: 'any-hit', hitCounts: 'sum',
      lines: [...results.unmeasured.values()].some(measures => measures.includes('codeLines')) ? 'code-when-classified' : 'code-only' },
    ...(securityScanners.length ? { securityScanners } : {}),
    plugins: [...plugins, ...languages.native.filter(plugin => plugin.unavailableReason !== undefined)].map(pluginProvenance),
    operations: results.operationRecords(),
  };
}

function pluginProvenance({ id, version, api, tools, kinds, claims, settings, providesLanguages, unavailableReason }: NativeLanguagePlugin) {
  return { id, version, api, tools: tools ?? {}, kinds,
    ...(claims === undefined ? {} : { claims }), ...(settings === undefined ? {} : { settings }),
    ...(providesLanguages === undefined ? {} : { providesLanguages: providesLanguages.map(({ syntax, ...language }) => language) }), ...(unavailableReason === undefined ? {} : { unavailableReason }) };
}

function inspectionStatus(hasSources: boolean, results: AnalysisResults): Report['status'] {
  if (results.diagnostics.length > 0) return 'partial';
  return !hasSources && !results.completedInspection ? 'not-applicable' : 'complete';
}

function reportInventory(snapshot: SourceSnapshot, sources: AnalysisSources, results: AnalysisResults) {
  const inventory = new Map((snapshot.inventory ?? []).map(({ path, lines, bytes }) => [path, { lines, bytes }]));
  for (const { path, bytes } of snapshot.files) {
    if (!inventory.has(path)) inventory.set(path, { lines: textLineCount(bytes), bytes: bytes.length });
  }
  return [...inventory].sort(([left], [right]) => comparePaths(left, right)).map(([path, { lines, bytes }]) => {
    const provider = sources.providersByPath.get(path);
    const unmeasured = sources.unavailableFiles.has(path) ? structureMeasures : results.unmeasured.get(path);
    return { path, lines, ...(bytes === undefined ? {} : { bytes }), language: provider?.language(path) ?? fileTypeId(path),
      analysed: results.parsed.has(path) || results.inspected.has(path), ...(provider === undefined ? {} : { provider: provider.key }),
      ...(unmeasured === undefined ? {} : { unmeasured }) };
  });
}
