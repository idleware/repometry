import { extname } from 'node:path';
import { execute } from '../core/engine/execute.js';
import type { Outcome } from '../core/engine/execute.js';
import { plan } from '../core/engine/plan.js';
import type { PlannedOperation } from '../core/engine/plan.js';
import type { FileClaims, Plugin } from '../core/engine/plugin.js';
import { ReportProducts } from '../core/engine/report-products.js';
import type { CloneSource } from '../core/model/clone-source.js';
import type { Finding } from '../core/model/finding.js';
import { definitions } from '../core/model/measurement.js';
import type { Measurement } from '../core/model/measurement.js';
import { debtModel } from '../core/model/quality-summary.js';
import { reportSchema } from '../core/model/report.js';
import type { Diagnostic, Report } from '../core/model/report.js';
import { comparePaths, digest, sourceDirectoriesExcluded, sourceExtensions, sourceFile, sourceLineCounts, textLineCount } from '../core/model/snapshot.js';
import { defaultSourceExclusions, exclusionMatcher, generatedSourcePolicy, sourceExclusionMatcher } from '../core/profile/exclusions.js';
import { duplicationSettings, structuralRules } from '../core/profile/maintainability.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import { coverage, coverageResult, lcovInput } from '../plugins/coverage/coverage.js';
import { duplication, duplicationInput } from '../plugins/duplication/duplication.js';
import { babelProvider, babelTypes, parserDefaults } from '../plugins/language-js/babel-provider.js';
import { fileQuality, maintainability } from '../plugins/maintainability/maintainability.js';
import { structure } from '../plugins/structure/structure.js';

const sourcePlugins = [babelProvider, { ...structure, tools: babelTypes }, { ...maintainability, tools: babelTypes }];
const selected = ['structure/size', 'structure/complexity', 'maintainability/file'] as const;
const bindings = new Map(selected.map(operation => [operation, { syntax: { operation: 'babel-syntax/parse' } }]));
const sourcePlan = plan({ plugins: sourcePlugins, select: selected, inputs: new Map([['file', sourceFile.id]]), bindings });
const duplicationPlan = plan({ plugins: [duplication], select: ['duplication/detect'], inputs: new Map([['sources', duplicationInput.id]]) });
const coveragePlan = plan({ plugins: [coverage], select: ['lcov/import', 'lcov/lines'], inputs: new Map([['lcov', lcovInput.id]]) });

const measurementDefinitions = {
  [definitions.lines]: 'Physical lines including blank lines and comments. A final line terminator does not add a line.',
  [definitions.functions]: 'Babel function nodes with bodies, including nested functions and methods.',
  [definitions.complexity]: 'One plus branches in the function body: if, ternary, loops, catch, non-default switch cases and logical operators. Nested functions are measured separately. Line and column are 1-based and columns count UTF-16 units.',
  [definitions.coverage]: 'Distinct covered DA lines divided by the distinct DA lines listed for mapped files. Duplicate records are merged by the presence of any hit. A zero denominator has no ratio.',
  [definitions.codeLines]: 'Nonblank physical lines after removing Babel comment spans and the interpreter directive. A line containing both code and a comment counts as code.',
  [definitions.comments]: 'Physical lines containing only a Babel comment or interpreter directive.',
  [definitions.classes]: 'Babel class declaration and expression nodes.',
  [definitions.cognitiveComplexity]: 'Flow breaks plus nesting weight and logical operator sequences. Nested functions are measured separately. File complexity sums functions and module-level flow breaks.',
  [definitions.duplicatedLines]: 'Distinct code lines inside repeated Babel syntax subtrees, including original and repeated occurrences. Identifier and literal spellings are ignored for similar-code matches.',
};

export async function analyzeSnapshot({ snapshot, excludedOutput, excludedPaths = [], coverage: inputCoverage }: AnalysisInput,
  additional: readonly Plugin[] = []): Promise<Report> {
  const rows: Measurement[] = [];
  const diagnostics: Diagnostic[] = [];
  const findings: Finding[] = [];
  const cloneSources: CloneSource[] = [];
  const enabled = [...sourcePlugins, duplication, ...(inputCoverage === undefined ? [] : [coverage])];
  const plugins = [...enabled, ...additional];
  if (additional.length) plan({ plugins, select: [], inputs: new Map() });
  if (inputCoverage === undefined && additional.some(plugin => plugin.id === coverage.id)) throw new Error('An additional plugin uses a built-in plugin ID');
  const reportProducts = new ReportProducts(plugins);
  const sourcePlans = new Map<string, readonly PlannedOperation[]>([['', sourcePlan]]);
  const usedPlans = new Map(sourcePlan.map(task => [task.key, task]));
  const matches = additional.map(plugin => claimMatcher(plugin.claims));
  const parsed = new Set<string>();

  for (const file of snapshot.files) {
    const selectedPlugins = additional.filter((_, index) => matches[index]!(file.path));
    const group = JSON.stringify(selectedPlugins.map(plugin => plugin.id));
    const groupKey = selectedPlugins.length === 0 ? '' : group;
    const tasks = sourcePlans.get(groupKey) ?? plan({
      plugins: [...sourcePlugins, ...additional],
      select: [...selected, ...selectedPlugins.flatMap(plugin => plugin.operations
        .filter(operation => operation.role === 'inspection').map(operation => `${plugin.id}/${operation.id}`))],
      inputs: new Map([['file', sourceFile.id]]), bindings,
    });
    sourcePlans.set(groupKey, tasks);
    const results = await execute(tasks, new Map([['file', { contract: sourceFile.id, value: file }]]));
    if (results.get('babel-syntax/parse')?.state === 'completed') parsed.add(file.path);
    for (const task of tasks) {
      usedPlans.set(task.key, task);
      const outcome = results.get(task.key)!;
      record(task, outcome, file.path);
      if (outcome.state === 'completed' && outcome.product.contract === fileQuality.id && fileQuality.accepts(outcome.product.value)) {
        cloneSources.push(outcome.product.value.cloneSource);
      }
    }
  }

  const copies = (await execute(duplicationPlan, new Map([['sources', { contract: duplicationInput.id, value: cloneSources }]])))
    .get('duplication/detect')!;
  record(duplicationPlan[0]!, copies);

  if (inputCoverage !== undefined) {
    const value = { text: inputCoverage.text, root: inputCoverage.sourceRoot, sourceLines: sourceLineCounts(snapshot.files),
      excludes: sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded) };
    const outcomes = await execute(coveragePlan, new Map([['lcov', { contract: lcovInput.id, value }]]));
    for (const task of coveragePlan) record(task, outcomes.get(task.key)!);
    const result = outcomes.get('lcov/import')!;
    if (result.state === 'completed' && coverageResult.accepts(result.product.value)) {
      for (const { path, reason } of result.product.value.gaps) {
        diagnostics.push({ operation: 'lcov/import', state: 'partial', path, message: reason });
      }
    }
  }

  const pluginData = reportProducts.result();
  const inventory = new Map((snapshot.inventory ?? []).map(({ path, lines, bytes }) => [path, { lines, bytes }]));
  for (const { path, bytes } of snapshot.files) {
    if (!inventory.has(path)) inventory.set(path, { lines: textLineCount(bytes), bytes: bytes.length });
  }
  return {
    schema: reportSchema,
    subject: snapshot.subject,
    generatedAt: new Date().toISOString(),
    appliedConfig: {
      profile: 'js-ts/v2', mode: snapshot.subject.kind,
      source: { extensions: sourceExtensions, excludedDirectories: sourceDirectoriesExcluded, excludedOutput, excludedPaths,
        defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
      parser: parserDefaults,
      maintainability: { structuralRules, duplication: duplicationSettings, debtModel, remediation: 'nonoverlapping-complexity/v1' },
      coverage: inputCoverage === undefined ? null : { inputDigest: digest(inputCoverage.text), pathBase: inputCoverage.sourceRoot, merge: 'any-hit' },
      plugins: plugins.map(({ id, version, api, tools, kinds, claims }) =>
        ({ id, version, api, tools: tools ?? {}, ...(kinds === undefined ? {} : { kinds }), ...(claims === undefined ? {} : { claims }) })),
      operations: [...usedPlans.values(), ...duplicationPlan, ...(inputCoverage === undefined ? [] : coveragePlan)]
        .map(task => ({ key: task.key, inputs: Object.fromEntries(task.inputs) })),
    },
    definitions: { ...Object.fromEntries((pluginData?.metrics ?? []).map(metric => [metric.id, metric.description ?? metric.label])),
      ...measurementDefinitions },
    scope: { files: snapshot.files.length, parsed: parsed.size },
    status: diagnostics.length > 0 ? 'partial' : snapshot.files.length === 0 ? 'not-applicable' : 'complete',
    measurements: rows,
    diagnostics,
    findings,
    ...(pluginData === undefined ? {} : { pluginData: { ...pluginData,
      inventory: [...inventory].sort(([left], [right]) => comparePaths(left, right)).map(([path, { lines, bytes }]) =>
        ({ path, lines, ...(bytes === undefined ? {} : { bytes }), language: languageId(path), analysed: parsed.has(path) })) } }),
  };

  function record(task: PlannedOperation, outcome: Outcome, path?: string): void {
    if (outcome.state !== 'completed') {
      diagnostics.push(diagnostic(task.key, outcome, path));
      return;
    }
    try {
      const stored = reportProducts.record(task, outcome.product, path);
      if (stored) {
        rows.push(...stored.measurements);
        findings.push(...stored.findings);
      }
    } catch (error) {
      diagnostics.push({ operation: task.key, state: 'failed', path, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function languageId(path: string): string {
  const suffix = extname(path).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(suffix)) return 'javascript';
  if (['.ts', '.mts', '.cts', '.tsx'].includes(suffix)) return 'typescript';
  if (suffix === '.md' || suffix === '.mdx') return 'markdown';
  if (suffix === '.yml') return 'yaml';
  if (suffix === '.py') return 'python';
  if (suffix === '.rs') return 'rust';
  if (suffix === '.kt' || suffix === '.kts') return 'kotlin';
  return suffix.slice(1) || 'other';
}

function claimMatcher(claims: FileClaims | undefined): (path: string) => boolean {
  const { extensions = [], globs = [], languages = [] } = claims ?? {};
  if (extensions.length === 0 && globs.length === 0 && languages.length === 0) return () => true;
  const glob = exclusionMatcher(globs);
  const suffixes = new Set(extensions);
  const languageSet = new Set(languages);
  return path => suffixes.has(extname(path)) || glob(path) || languageSet.has(languageId(path));
}

function diagnostic(operation: string, outcome: Exclude<Outcome, { state: 'completed' }>, path?: string): Diagnostic {
  return { operation, state: outcome.state, message: outcome.reason, ...(path === undefined ? {} : { path }) };
}
