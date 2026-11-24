import { execute } from '../core/engine/execute.js';
import type { Outcome } from '../core/engine/execute.js';
import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import { plan } from '../core/engine/plan.js';
import type { PlannedOperation } from '../core/engine/plan.js';
import type { Plugin } from '../core/engine/plugin.js';
import { codeStructures } from '../core/model/code-structure.js';
import type { CodeStructure } from '../core/model/code-structure.js';
import { sourceFiles } from '../core/model/snapshot.js';
import { isClaimedText } from '../core/model/source.js';
import type { SourceFile } from '../core/model/source.js';
import type { AnalysisResults } from './analysis-results.js';
import { inspectionKeys } from './analysis-sources.js';
import type { AnalysisSources } from './analysis-sources.js';
import { canReuseBatch } from './history-cache.js';
import type { HistoryFiles } from './history-cache.js';

const repositoryInput = new Map([['files', sourceFiles.id]]);

export async function collectRepositorySyntax(sources: AnalysisSources, results: AnalysisResults, cache?: OperationCacheOptions,
  history?: HistoryFiles) {
  const providers = new Map(sources.languages.providers.filter(provider => provider.batch).map(provider => [provider.plugin.id, provider]));
  const facts = new Map<string, CodeStructure>();
  for (const { plugin } of sources.repository) {
    const provider = providers.get(plugin.id);
    if (!provider) continue;
    const files = sources.sources.filter(source => source.provider === provider).map(({ file }) => file);
    if (!files.length) continue;
    const reusable = canReuseBatch(provider) ? history : undefined;
    const outcomes = await runRepository(plugin, files, [provider.key, ...inspectionKeys(plugin)], results, cache, reusable);
    const syntax = outcomes.get(provider.key);
    if (syntax?.state === 'completed' && codeStructures.accepts(syntax.product.value)) {
      collectFacts(facts, syntax.product.value, files, provider.key, results);
    }
  }
  return facts;
}

export async function inspectRepositories(sources: AnalysisSources, results: AnalysisResults, cache?: OperationCacheOptions): Promise<void> {
  for (const { plugin, matches } of sources.repository) {
    if (sources.languages.providers.some(provider => provider.batch && provider.plugin.id === plugin.id)) continue;
    const select = inspectionKeys(plugin);
    if (!select.length) continue;
    const files = sources.sources.map(({ file }) => file).filter(file => matches(file.path) && isClaimedText(file.bytes));
    if (files.length) await runRepository(plugin, files, select, results, cache);
  }
}

async function runRepository(plugin: Plugin, files: readonly SourceFile[], select: readonly string[],
  results: AnalysisResults, cache?: OperationCacheOptions, history?: HistoryFiles) {
  const tasks = plan({ plugins: [plugin], select, inputs: repositoryInput });
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
