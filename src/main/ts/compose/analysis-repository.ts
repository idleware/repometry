import { execute } from '../core/engine/execute.js';
import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import { plan } from '../core/engine/plan.js';
import type { Plugin } from '../core/engine/plugin.js';
import { codeStructures } from '../core/model/code-structure.js';
import type { CodeStructure } from '../core/model/code-structure.js';
import { sourceFiles } from '../core/model/snapshot.js';
import { isClaimedText } from '../core/model/source.js';
import type { SourceFile } from '../core/model/source.js';
import type { AnalysisResults } from './analysis-results.js';
import { inspectionKeys } from './analysis-sources.js';
import type { AnalysisSources } from './analysis-sources.js';

const repositoryInput = new Map([['files', sourceFiles.id]]);

export async function collectRepositorySyntax(sources: AnalysisSources, results: AnalysisResults, cache?: OperationCacheOptions) {
  const providers = new Map(sources.languages.providers.filter(provider => provider.batch).map(provider => [provider.plugin.id, provider]));
  const facts = new Map<string, CodeStructure>();
  for (const { plugin } of sources.repository) {
    const provider = providers.get(plugin.id);
    if (!provider) continue;
    const files = sources.sources.filter(source => source.provider === provider).map(({ file }) => file);
    if (!files.length) continue;
    const outcomes = await runRepository(plugin, files, [provider.key, ...inspectionKeys(plugin)], results, cache);
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
  results: AnalysisResults, cache?: OperationCacheOptions) {
  const tasks = plan({ plugins: [plugin], select, inputs: repositoryInput });
  const outcomes = await execute(tasks, new Map([['files', { contract: sourceFiles.id, value: files }]]), cache);
  const paths = files.map(({ path }) => path);
  for (const task of tasks) {
    results.remember(task);
    results.record(task, outcomes.get(task.key)!, undefined, paths);
  }
  return outcomes;
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
