import type { Plugin } from '../core/engine/plugin.js';
import { definitions } from '../core/model/measurement.js';
import { debtModel } from '../core/model/quality-summary.js';
import { reportSchema } from '../core/model/report.js';
import type { Report } from '../core/model/report.js';
import { comparePaths, digest, sourceDirectoriesExcluded, textLineCount } from '../core/model/snapshot.js';
import type { SourceSnapshot } from '../core/model/source.js';
import { defaultSourceExclusions, generatedSourcePolicy } from '../core/profile/exclusions.js';
import { duplicationSettings, structuralRules } from '../core/profile/maintainability.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import { parserDefaults } from '../plugins/language-js/babel-provider.js';
import type { AnalysisResults } from './analysis-results.js';
import type { AnalysisSources } from './analysis-sources.js';
import { languageId } from './languages.js';

const measurementDefinitions = {
  [definitions.lines]: 'Physical lines including blank lines and comments. A final line terminator does not add a line.',
  [definitions.functions]: 'Babel function nodes with bodies, including nested functions and methods.',
  [definitions.complexity]: 'One plus branches in the function body: if, ternary, loops, catch, non-default switch cases and logical operators. Nested functions are measured separately. Line and column are 1-based and columns count UTF-16 units.',
  [definitions.coverage]: 'Distinct covered code lines divided by the distinct code lines listed in LCOV DA records. Hit counts are summed across records. A zero denominator has no ratio.',
  [definitions.codeLines]: 'Nonblank physical lines after removing Babel comment spans and the interpreter directive. A line containing both code and a comment counts as code.',
  [definitions.comments]: 'Physical lines containing only a Babel comment or interpreter directive.',
  [definitions.classes]: 'Babel class declaration and expression nodes.',
  [definitions.cognitiveComplexity]: 'Flow breaks plus nesting weight and logical operator sequences. Nested functions are measured separately. File complexity sums functions and module-level flow breaks.',
  [definitions.duplicatedLines]: 'Distinct code lines inside repeated Babel syntax subtrees, including original and repeated occurrences. Identifier and literal spellings are ignored for similar-code matches.',
};

export function assembleAnalysisReport(input: AnalysisInput, sources: AnalysisSources, results: AnalysisResults): Report {
  const pluginData = results.pluginData();
  const { snapshot } = input;
  const fileCount = sources.sourceFiles.length;
  return {
    schema: reportSchema,
    subject: snapshot.subject,
    generatedAt: new Date().toISOString(),
    appliedConfig: appliedConfiguration(input, sources, results),
    definitions: { ...Object.fromEntries((pluginData?.metrics ?? []).map(metric => [metric.id, metric.description ?? metric.label])),
      ...measurementDefinitions },
    scope: { files: fileCount, parsed: results.parsed.size },
    status: inspectionStatus(fileCount, results),
    measurements: results.measurements,
    diagnostics: results.diagnostics,
    findings: results.findings,
    ...(pluginData === undefined ? {} : { pluginData: { ...pluginData, languages: sources.languages.catalog,
      inventory: reportInventory(snapshot, sources, results) } }),
  };
}

function appliedConfiguration({ snapshot, excludedOutput, excludedPaths = [], coverage }: AnalysisInput,
  { languages, claimedPlugins, plugins }: AnalysisSources, results: AnalysisResults): Report['appliedConfig'] {
  const securityScanners = results.securityScanners(claimedPlugins);
  return {
    profile: 'js-ts/v2', mode: snapshot.subject.kind,
    source: { extensions: languages.extensions, ...(languages.globs.length ? { globs: languages.globs } : {}),
      excludedDirectories: sourceDirectoriesExcluded, excludedOutput, excludedPaths,
      defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
    parser: parserDefaults,
    maintainability: { structuralRules, duplication: duplicationSettings, debtModel, remediation: 'nonoverlapping-complexity/v1' },
    coverage: coverage === undefined ? null : { inputDigest: digest(coverage.text), pathBase: coverage.sourceRoot,
      merge: 'any-hit', hitCounts: 'sum', lines: 'code-only' },
    ...(securityScanners.length ? { securityScanners } : {}),
    plugins: plugins.map(pluginProvenance),
    operations: results.operationRecords(),
  };
}

function pluginProvenance({ id, version, api, tools, kinds, claims, settings, providesLanguages }: Plugin) {
  return { id, version, api, tools: tools ?? {}, kinds,
    ...(claims === undefined ? {} : { claims }), ...(settings === undefined ? {} : { settings }),
    ...(providesLanguages === undefined ? {} : { providesLanguages }) };
}

function inspectionStatus(fileCount: number, results: AnalysisResults): Report['status'] {
  if (results.diagnostics.length > 0) return 'partial';
  return fileCount === 0 && !results.completedInspection ? 'not-applicable' : 'complete';
}

function reportInventory(snapshot: SourceSnapshot, sources: AnalysisSources, results: AnalysisResults) {
  const inventory = new Map((snapshot.inventory ?? []).map(({ path, lines, bytes }) => [path, { lines, bytes }]));
  for (const { path, bytes } of snapshot.files) {
    if (!inventory.has(path)) inventory.set(path, { lines: textLineCount(bytes), bytes: bytes.length });
  }
  return [...inventory].sort(([left], [right]) => comparePaths(left, right)).map(([path, { lines, bytes }]) => {
    const provider = sources.providersByPath.get(path);
    return { path, lines, ...(bytes === undefined ? {} : { bytes }), language: provider?.language(path) ?? languageId(path),
      analysed: results.parsed.has(path) || results.inspected.has(path), ...(provider === undefined ? {} : { provider: provider.key }) };
  });
}
