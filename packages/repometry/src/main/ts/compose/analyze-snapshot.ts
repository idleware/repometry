import type { OperationCacheOptions } from '@repometry/core/internal/engine/operation-cache.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import type { AnalysisInput } from '@repometry/core/internal/usecases/inspect.js';
import { collectRepositorySyntax, defaultFilePlan, inspectAfterFiles, inspectFiles, inspectRepositories } from './analysis-steps.js';
import { assembleAnalysisReport } from './analysis-report.js';
import { AnalysisResults } from './analysis-results.js';
import { selectAnalysisSources } from './phases.js';
import { historyProfile } from './history-cache.js';
import type { HistoryCache } from './history-cache.js';
import type { LanguageRegistry } from './languages.js';
import { pluginScope } from './plugin-scope.js';

export { inspectionFileMatcher } from './phases.js';

export async function analyzeSnapshot(input: AnalysisInput, languages: LanguageRegistry,
  cache?: OperationCacheOptions, history?: HistoryCache): Promise<Report> {
  const sources = selectAnalysisSources(input.snapshot, input.coverage !== undefined, languages);
  const reusable = history?.begin(input.snapshot, historyProfile(input, sources, cache?.configurationDigest));
  const results = new AnalysisResults(sources.plugins, input.snapshot.oversizedClaims ?? []);
  const defaults = languages.plugins.some(pluginScope) ? [] : defaultFilePlan(sources);
  for (const task of defaults) results.remember(task);

  const batchFacts = await collectRepositorySyntax(sources, results, cache, reusable);
  const parsed = await inspectFiles(sources, batchFacts, results, cache, reusable);
  await inspectRepositories(sources, results, cache);
  await inspectAfterFiles(input, sources, parsed, results, cache);

  return assembleAnalysisReport(input, sources, results);
}
