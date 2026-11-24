import { execute } from '../core/engine/execute.js';
import type { Outcome } from '../core/engine/execute.js';
import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import { plan } from '../core/engine/plan.js';
import type { InputBinding, PlannedOperation } from '../core/engine/plan.js';
import type { Plugin, Product } from '../core/engine/plugin.js';
import type { CloneSource } from '../core/model/clone-source.js';
import { codeStructure, structuralCheckIds, structureCodeLines } from '../core/model/code-structure.js';
import type { CodeStructure } from '../core/model/code-structure.js';
import { sourceFile } from '../core/model/snapshot.js';
import { isClaimedText, maxClaimedFileBytes } from '../core/model/source.js';
import type { SourceLineRange } from '../core/model/source.js';
import { fileQuality } from '../plugins/maintainability/maintainability.js';
import { oversizedClaim } from './analysis-results.js';
import type { AnalysisResults } from './analysis-results.js';
import { defaultProvider, inspectionKeys, pluginForScope, structuralInspections } from './analysis-sources.js';
import type { AnalysisSources, SelectedSource } from './analysis-sources.js';
import type { LanguageProvider } from './languages.js';
import { unmeasuredStructure } from './structure-measures.js';

const standardInspections = ['structure/size', 'structure/complexity', 'maintainability/file'] as const;
const fileInput = new Map([['file', sourceFile.id]]);
const batchFileInput = new Map([...fileInput, ['syntax', codeStructure.id]]);
export const defaultFilePlan = filePlan(defaultProvider, []);

export interface FileAnalysis {
  readonly cloneSources: readonly CloneSource[];
  readonly codeLines: ReadonlyMap<string, ReadonlySet<number>>;
  readonly functionBodies: ReadonlyMap<string, readonly SourceLineRange[]>;
}

export async function inspectFiles(sources: AnalysisSources, batchFacts: ReadonlyMap<string, CodeStructure>,
  results: AnalysisResults, withCoverage: boolean, cache?: OperationCacheOptions): Promise<FileAnalysis> {
  const plans = new Map<string, readonly PlannedOperation[]>([[filePlanKey(defaultProvider, []), defaultFilePlan]]);
  const cloneSources: CloneSource[] = [];
  const codeLines = new Map<string, ReadonlySet<number>>();
  const functionBodies = new Map<string, readonly SourceLineRange[]>();
  for (const source of sources.sources) {
    const plugins = matchedInspections(source, sources, results);
    const { file, provider } = source;
    if (!provider && !plugins.length) continue;
    const tasks = findFilePlan(provider, plugins, plans, results);
    const facts = batchFacts.get(file.path);
    const products = new Map<string, Product>([['file', { contract: sourceFile.id, value: file }]]);
    if (facts) products.set('syntax', { contract: codeStructure.id, value: facts });
    const outcomes = await execute(tasks, products, cache);
    const syntax = provider && outcomes.get(provider.key);
    const parsed = recordFileSyntax(source, syntax, facts, results, withCoverage);
    if (withCoverage && parsed) {
      const lines = structureCodeLines(parsed);
      if (lines !== undefined) codeLines.set(file.path, new Set(lines));
      if (parsed.functionBodies !== undefined) functionBodies.set(file.path, parsed.functionBodies);
    }
    collectFileProducts(tasks, outcomes, source, cloneSources, results);
  }
  return { cloneSources, codeLines, functionBodies };
}

function matchedInspections({ file }: SelectedSource, sources: AnalysisSources, results: AnalysisResults): Plugin[] {
  const claimed = sources.perFile.filter(({ matches }) => matches(file.path));
  if (claimed.length && file.bytes.byteLength > maxClaimedFileBytes) results.diagnostics.push(oversizedClaim(file.path));
  return isClaimedText(file.bytes) ? claimed.map(({ plugin }) => plugin) : [];
}

function findFilePlan(provider: LanguageProvider | undefined, plugins: readonly Plugin[],
  plans: Map<string, readonly PlannedOperation[]>, results: AnalysisResults) {
  const key = filePlanKey(provider, plugins);
  const cached = plans.get(key);
  if (cached) return cached;
  const tasks = filePlan(provider, plugins);
  plans.set(key, tasks);
  for (const task of tasks) {
    const consumesBatch = provider?.batch && [...task.inputs.values()].some(input => 'external' in input && input.external === 'syntax');
    results.remember(task, consumesBatch ? provider.key : undefined);
  }
  return tasks;
}

function filePlan(provider: LanguageProvider | undefined, plugins: readonly Plugin[]): readonly PlannedOperation[] {
  const inspections = plugins.flatMap(inspectionKeys);
  if (!provider) return plan({ plugins, select: inspections, inputs: fileInput });
  const needsProvider = !provider.batch && plugins.every(plugin => plugin.id !== provider.plugin.id);
  const syntax: InputBinding = provider.batch ? { external: 'syntax' } : { operation: provider.key };
  const providers = needsProvider ? [pluginForScope(provider.plugin, 'file')] : [];
  return plan({
    plugins: [...providers, ...structuralInspections, ...plugins],
    select: [...standardInspections, ...inspections],
    inputs: provider.batch ? batchFileInput : fileInput,
    bindings: new Map(standardInspections.map(operation => [operation, { syntax }])),
  });
}

function filePlanKey(provider: LanguageProvider | undefined, plugins: readonly Plugin[]): string {
  return JSON.stringify([provider?.key ?? null, ...plugins.map(plugin => plugin.id)]);
}

function recordFileSyntax({ file, provider }: SelectedSource, outcome: Outcome | undefined, batch: CodeStructure | undefined,
  results: AnalysisResults, withCoverage: boolean): CodeStructure | undefined {
  const value = outcome?.state === 'completed' ? outcome.product.value : undefined;
  const builtinParsed = provider === defaultProvider && value !== undefined;
  const facts = batch ?? ((!builtinParsed || withCoverage) && codeStructure.accepts(value) ? value : undefined);
  if (facts || builtinParsed) results.parsed.add(file.path);
  if (facts && !builtinParsed) recordUnmeasured(file.path, facts, results);
  return facts;
}

function recordUnmeasured(path: string, facts: CodeStructure, results: AnalysisResults): void {
  const unmeasured = unmeasuredStructure(facts);
  if (unmeasured.length) results.unmeasured.set(path, unmeasured);
  if (facts.observations === undefined) {
    results.ruleSkips.push({ path, plugin: 'maintainability', rules: structuralCheckIds, reason: 'unmeasured' });
  }
  if (facts.clones === undefined) {
    results.ruleSkips.push({ path, plugin: 'duplication', rules: ['identical-code', 'similar-code'], reason: 'unmeasured' });
  }
}

function collectFileProducts(tasks: readonly PlannedOperation[], outcomes: ReadonlyMap<string, Outcome>,
  { file, provider }: SelectedSource, clones: CloneSource[], results: AnalysisResults): void {
  for (const task of tasks) {
    const outcome = outcomes.get(task.key)!;
    results.record(task, outcome, file.path);
    const source = cloneSource(outcome, provider);
    if (source) clones.push(source);
  }
}

function cloneSource(outcome: Outcome, provider: LanguageProvider | undefined): CloneSource | undefined {
  if (outcome.state !== 'completed' || outcome.product.contract !== fileQuality.id || !fileQuality.accepts(outcome.product.value)) return;
  const source = outcome.product.value.cloneSource;
  return source && provider && source.scheme === undefined ? { ...source, scheme: provider.plugin.id } : source;
}
