import { execute } from '../core/engine/execute.js';
import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import { plan } from '../core/engine/plan.js';
import { sourceLineCounts } from '../core/model/snapshot.js';
import { sourceExclusionMatcher } from '../core/profile/exclusions.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import { coverage, coverageResult, lcovInput } from '../plugins/coverage/coverage.js';
import { duplication, duplicationInput } from '../plugins/duplication/duplication.js';
import type { FileAnalysis } from './analysis-files.js';
import type { AnalysisResults } from './analysis-results.js';
import type { AnalysisSources } from './analysis-sources.js';

const duplicationPlan = plan({ plugins: [duplication], select: ['duplication/detect'], inputs: new Map([['sources', duplicationInput.id]]) });
const coveragePlan = plan({ plugins: [coverage], select: ['lcov/import', 'lcov/lines'], inputs: new Map([['lcov', lcovInput.id]]) });

export async function inspectDuplication(files: FileAnalysis, results: AnalysisResults, cache?: OperationCacheOptions): Promise<void> {
  const inputs = new Map([['sources', { contract: duplicationInput.id, value: files.cloneSources }]]);
  const outcomes = await execute(duplicationPlan, inputs, cache);
  const [task] = duplicationPlan;
  results.remember(task!);
  results.record(task!, outcomes.get(task!.key)!);
}

export async function importAnalysisCoverage({ coverage: input, excludedPaths = [], snapshot }: AnalysisInput,
  sources: AnalysisSources, files: FileAnalysis, results: AnalysisResults, cache?: OperationCacheOptions): Promise<void> {
  if (input === undefined) return;
  const unclassified = new Set([...results.unmeasured].filter(([, missing]) => missing.includes('codeLines')).map(([path]) => path));
  const excludes = sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded);
  const value = { text: input.text, root: input.sourceRoot, sourceLines: sourceLineCounts(sources.sourceFiles),
    codeLines: files.codeLines, unclassified, functionBodies: files.functionBodies,
    excludes: (path: string) => excludes(path) || sources.unavailableFiles.has(path) };
  const outcomes = await execute(coveragePlan, new Map([['lcov', { contract: lcovInput.id, value }]]), cache);
  for (const task of coveragePlan) {
    results.remember(task);
    results.record(task, outcomes.get(task.key)!);
  }
  const outcome = outcomes.get('lcov/import');
  if (outcome?.state !== 'completed' || !coverageResult.accepts(outcome.product.value)) return;
  for (const { path, reason } of outcome.product.value.gaps) {
    results.diagnostics.push({ operation: 'lcov/import', state: 'partial', path, message: reason });
  }
}
