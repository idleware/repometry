import { execute } from '@repometry/core/internal/engine/execute.js';
import type { Outcome } from '@repometry/core/internal/engine/execute.js';
import type { OperationCacheOptions } from '@repometry/core/internal/engine/operation-cache.js';
import { plan } from '@repometry/core/internal/engine/plan.js';
import type { PlannedOperation } from '@repometry/core/internal/engine/plan.js';
import type { Plugin, Product } from '@repometry/core/internal/engine/plugin.js';
import { cloneSources as cloneSourcesContract } from '@repometry/core/internal/model/clone-source.js';
import { codeStructure, codeStructures, ruleCategoryMeasures, structureCodeLines } from '@repometry/core/internal/model/code-structure.js';
import type { CodeStructure } from '@repometry/core/internal/model/code-structure.js';
import { lcovInput } from '@repometry/core/internal/model/coverage-input.js';
import { sourceFile, sourceFiles, sourceLineCounts } from '@repometry/core/internal/model/snapshot.js';
import { isClaimedText, maxClaimedFileBytes } from '@repometry/core/internal/model/source.js';
import type { SourceFile } from '@repometry/core/internal/model/source.js';
import { sourceExclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import type { AnalysisInput } from '@repometry/core/internal/usecases/inspect.js';
import { oversizedClaim } from './analysis-results.js';
import type { AnalysisResults } from './analysis-results.js';
import { canReuseBatch } from './history-cache.js';
import type { HistoryFiles } from './history-cache.js';
import type { LanguageProvider } from './languages.js';
import { analysisPhases, phaseInputs } from './phases.js';
import type { AnalysisSources, Inspection, SelectedSource, Step } from './phases.js';
import { unmeasuredStructure } from './structure-measures.js';

// The steps of an analysis in run order. Each runs what the phases chose for it; none decides what runs where.

const { files: filesPhase, repository: repositoryPhase } = analysisPhases(false);

/** A parsed file's structure, kept for the inspections after the files, and the plugin that parsed it. */
export type ParsedFile = Readonly<{ path: string; structure: CodeStructure; parser: string }>;

/** The plan of a file the first provider parses and nothing claims, recorded before any file so the records keep their order. */
export function defaultFilePlan(sources: AnalysisSources): readonly PlannedOperation[] {
  const [provider] = sources.languages.providers;
  if (!provider || !sources.sources.some(source => source.provider === provider)) return [];
  // Language plugins claim the files they parse, so only the first provider's plugin and those without claims are left.
  const unclaimed = ({ claims, providesLanguages, id }: Plugin) => (!claims && !providesLanguages) || id === provider?.plugin.id;
  return filePlan(provider, sources.steps.files.inspections.filter(({ parsed, plugin }) => parsed && unclaimed(plugin)),
    sources.steps.files.candidates.filter(unclaimed));
}

/** Runs each language parsed over the repository on its files, with the plugin's other repository operations. */
export async function collectRepositorySyntax(sources: AnalysisSources, results: AnalysisResults, cache?: OperationCacheOptions,
  history?: HistoryFiles) {
  const facts = new Map<string, CodeStructure>();
  for (const { provider, ...step } of sources.steps.repositorySyntax) {
    const files = sources.sources.filter(source => source.provider === provider).map(({ file }) => file);
    if (!files.length) continue;
    const reusable = canReuseBatch(provider) ? history : undefined;
    const outcomes = await runRepository(step, files, [provider.key, ...step.inspections.map(({ key }) => key)], results, cache, reusable);
    const syntax = outcomes.get(provider.key); // execute() checked its value against the contract
    if (syntax?.state === 'completed') collectFacts(facts, syntax.product.value as CodeStructure[], files, provider.key, results);
  }
  return facts;
}

/** Runs each file's inspections, with its provider's parse unless the repository syntax already read the file. */
export async function inspectFiles(sources: AnalysisSources, batchFacts: ReadonlyMap<string, CodeStructure>,
  results: AnalysisResults, cache?: OperationCacheOptions, history?: HistoryFiles): Promise<ParsedFile[]> {
  const plans = new Map<string, readonly PlannedOperation[]>();
  const parsed: ParsedFile[] = [];
  for (const source of sources.sources) {
    const { file, provider } = source;
    const inspections = fileInspections(source, sources.steps.files, results);
    if (!provider && !inspections.length) continue;
    const tasks = findFilePlan(sources, source, inspections, plans, results);
    const facts = batchFacts.get(file.path);
    const reusable = provider?.batch && (!facts || !canReuseBatch(provider)) ? undefined : history;
    const outcomes = await fileOutcomes(source, tasks, facts, cache, reusable);
    const structure = facts ?? parsedStructure(provider && outcomes.get(provider.key));
    if (structure) parsed.push(recordParsed({ path: file.path, structure, parser: provider!.plugin.id }, results, sources.plugins));
    for (const task of tasks) results.record(task, outcomes.get(task.key)!, file.path);
  }
  return parsed;
}

/** Runs every other repository inspection on the files its plugin claims. */
export async function inspectRepositories(sources: AnalysisSources, results: AnalysisResults, cache?: OperationCacheOptions): Promise<void> {
  const step = sources.steps.repository;
  for (const plugin of new Set(step.inspections.map(({ plugin }) => plugin))) {
    const inspections = step.inspections.filter(inspection => inspection.plugin === plugin);
    const files = sources.sources.map(({ file }) => file).filter(file => inspections[0]!.matches(file.path, false) && isClaimedText(file.bytes));
    if (files.length) await runRepository(step, files, inspections.map(({ key }) => key), results, cache);
  }
}

/** Runs the inspections that read what the files phase gathered: clone sources and, when given, the coverage input. */
export async function inspectAfterFiles({ coverage: input, excludedPaths = [], snapshot }: AnalysisInput,
  sources: AnalysisSources, parsed: readonly ParsedFile[], results: AnalysisResults, cache?: OperationCacheOptions): Promise<void> {
  const clones = parsed.flatMap(({ structure: { clones }, parser }) => clones ? [{ ...clones, scheme: clones.scheme ?? parser }] : []);
  const products = new Map<string, Product>([['sources', { contract: cloneSourcesContract.id, value: clones }]]);
  if (input !== undefined) {
    const unclassified = new Set([...results.unmeasured].filter(([, missing]) => missing.includes('codeLines')).map(([path]) => path));
    const excludes = sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded);
    const codeLines = parsed.flatMap(({ path, structure }) => {
      const lines = structureCodeLines(structure);
      return lines === undefined ? [] : [[path, new Set(lines)] as const];
    });
    const functionBodies = parsed.flatMap(({ path, structure: { functionBodies } }) => functionBodies ? [[path, functionBodies] as const] : []);
    products.set('lcov', { contract: lcovInput.id, value: { text: input.text, root: input.sourceRoot,
      sourceLines: sourceLineCounts(sources.sourceFiles), codeLines: new Map(codeLines), unclassified,
      functionBodies: new Map(functionBodies), excludes: (path: string) => excludes(path) || sources.unavailableFiles.has(path) } });
  }
  const { candidates, inspections } = sources.steps.afterFiles;
  const tasks = plan({ plugins: candidates, select: inspections.map(({ key }) => key),
    inputs: new Map([...products].map(([port, { contract }]) => [port, contract])) });
  const outcomes = await execute(tasks, products, cache);
  for (const task of tasks) {
    results.remember(task);
    results.record(task, outcomes.get(task.key)!);
  }
}

function parsedStructure(outcome: Outcome | undefined): CodeStructure | undefined {
  return outcome?.state === 'completed' ? outcome.product.value as CodeStructure : undefined; // execute() checked the contract
}

async function fileOutcomes({ file }: SelectedSource, tasks: readonly PlannedOperation[], facts: CodeStructure | undefined,
  cache: OperationCacheOptions | undefined, history: HistoryFiles | undefined): Promise<ReadonlyMap<string, Outcome>> {
  const saved = history?.read(file.path)?.outcomes;
  if (saved) {
    history?.retain(file.path, { outcomes: saved });
    return saved;
  }
  const products = new Map<string, Product>([['file', { contract: sourceFile.id, value: file }]]);
  if (facts) products.set('syntax', { contract: codeStructure.id, value: facts });
  const outcomes = await execute(tasks, products, cache);
  if (history && [...outcomes.values()].every(outcome => outcome.state === 'completed' && !outcome.diagnostics?.length)) {
    history.retain(file.path, { outcomes });
  }
  return outcomes;
}

/** The inspections that run on a file. Those that run because their plugin claims it need a text file under the size limit. */
function fileInspections({ file, provider }: SelectedSource, { inspections }: Step, results: AnalysisResults): Inspection[] {
  const matched = inspections.filter(({ matches }) => matches(file.path, provider !== undefined));
  const claimed = matched.some(({ parsed }) => !parsed);
  if (claimed && file.bytes.byteLength > maxClaimedFileBytes) results.diagnostics.push(oversizedClaim(file.path));
  return isClaimedText(file.bytes) ? matched : matched.filter(({ parsed }) => parsed);
}

/** A file's plan, shared by the files with the same provider, inspections and claiming plugins. */
function findFilePlan(sources: AnalysisSources, { file, provider }: SelectedSource, inspections: readonly Inspection[],
  plans: Map<string, readonly PlannedOperation[]>, results: AnalysisResults) {
  // A consumer runs only where its producer may: the planner chooses from the plugins that claim the file.
  const claiming = sources.steps.files.candidates.filter(plugin => sources.steps.claims(plugin, file.path));
  const key = JSON.stringify([provider?.key ?? null, inspections.map(({ key }) => key), claiming.map(({ id }) => id)]);
  const cached = plans.get(key);
  if (cached) return cached;
  const tasks = filePlan(provider, inspections, claiming);
  plans.set(key, tasks);
  for (const task of tasks) {
    const consumesBatch = provider?.batch && [...task.inputs.values()].some(input => 'external' in input && input.external === 'syntax');
    results.remember(task, consumesBatch ? provider.key : undefined);
  }
  return tasks;
}

/** A file's plan: its provider's parse unless the repository syntax already read it, then the file's inspections. */
function filePlan(provider: LanguageProvider | undefined, inspections: readonly Inspection[], plugins: readonly Plugin[]): readonly PlannedOperation[] {
  const parse = provider && !provider.batch ? [provider.key] : [];
  return plan({ plugins, select: [...parse, ...inspections.map(({ key }) => key)],
    inputs: phaseInputs(filesPhase, provider?.batch ? undefined : codeStructure) });
}

/** Records a parsed file and, for each measure it lacks, a skip of the rules that need the measure. */
function recordParsed(file: ParsedFile, results: AnalysisResults, plugins: readonly Plugin[]): ParsedFile {
  const { path } = file;
  results.parsed.add(path);
  const unmeasured = unmeasuredStructure(file.structure);
  if (unmeasured.length) results.unmeasured.set(path, unmeasured);
  for (const plugin of plugins) {
    const rules = plugin.rules?.filter(({ category }) => unmeasured.some(measure => ruleCategoryMeasures[category] === measure))
      .map(({ id }) => id) ?? [];
    if (rules.length) results.ruleSkips.push({ path, plugin: plugin.id, rules, reason: 'unmeasured' });
  }
  return file;
}

async function runRepository({ candidates }: Step, files: readonly SourceFile[], select: readonly string[],
  results: AnalysisResults, cache?: OperationCacheOptions, history?: HistoryFiles) {
  const tasks = plan({ plugins: candidates, select, inputs: phaseInputs(repositoryPhase) });
  const outcomes = history && tasks.length === 1
    ? await runIndependentProvider(tasks[0]!, files, history, cache) : await executeRepository(tasks, files, cache);
  const paths = files.map(({ path }) => path);
  for (const task of tasks) {
    results.remember(task);
    results.record(task, outcomes.get(task.key)!, undefined, paths);
  }
  return outcomes;
}

function executeRepository(tasks: readonly PlannedOperation[], files: readonly SourceFile[], cache?: OperationCacheOptions) {
  return execute(tasks, new Map([['files', { contract: sourceFiles.id, value: files }]]), cache);
}

async function runIndependentProvider(task: PlannedOperation, files: readonly SourceFile[], history: HistoryFiles,
  cache?: OperationCacheOptions): Promise<ReadonlyMap<string, Outcome>> {
  const saved = new Map(files.flatMap(({ path }) => {
    const syntax = history.read(path)?.syntax;
    return syntax === undefined ? [] : [[path, syntax] as const];
  }));
  const missing = files.filter(({ path }) => !saved.has(path));
  const outcomes = missing.length === 0 ? undefined : await executeRepository([task], missing, cache);
  const fresh = outcomes === undefined ? [] : successfulBatch(outcomes.get(task.key), missing);

  // Preserve complete-batch diagnostics if an incremental run produces incomplete facts or a warning.
  if (!fresh) return saved.size ? executeRepository([task], files, cache) : outcomes!;
  for (const syntax of fresh) saved.set(syntax.path, syntax);
  const values = files.map(({ path }) => saved.get(path)!);
  const { output } = task.operation;
  if (missing.length !== files.length && (!output.accepts(values) || (task.validateOutput && !task.validateOutput(values)))) {
    return executeRepository([task], files, cache);
  }
  for (const syntax of values) history.retain(syntax.path, { syntax });
  return missing.length === files.length ? outcomes! : new Map([[task.key, {
    state: 'completed', product: { contract: output.id, value: values },
  }]]);
}

function successfulBatch(outcome: Outcome | undefined, files: readonly SourceFile[]) {
  if (outcome?.state !== 'completed' || outcome.diagnostics?.length || !codeStructures.accepts(outcome.product.value)) return;
  const values = outcome.product.value;
  const paths = new Set(files.map(({ path }) => path));
  if (values.length === paths.size && values.every(({ path }) => paths.has(path))) return values;
}

function collectFacts(target: Map<string, CodeStructure>, values: readonly CodeStructure[], files: readonly SourceFile[],
  operation: string, results: AnalysisResults): void {
  const planned = new Set(files.map(({ path }) => path));
  if (values.some(({ path }) => !planned.has(path))) {
    results.diagnostics.push({ operation, state: 'failed', message: 'Language provider returned a path outside its inputs' });
    return;
  }
  for (const facts of values) target.set(facts.path, facts);
  for (const path of planned) {
    if (!target.has(path)) results.diagnostics.push({ operation, state: 'failed', path, message: 'Language provider returned no structure for this file' });
  }
}
