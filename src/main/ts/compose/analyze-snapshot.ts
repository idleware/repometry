import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import type { Plugin } from '../core/engine/plugin.js';
import type { Report } from '../core/model/report.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import { collectRepositorySyntax, defaultFilePlan, inspectAfterFiles, inspectFiles, inspectRepositories } from './analysis-steps.js';
import { assembleAnalysisReport } from './analysis-report.js';
import { AnalysisResults } from './analysis-results.js';
import { selectAnalysisSources } from './phases.js';
import { historyProfile } from './history-cache.js';
import type { HistoryCache } from './history-cache.js';

export { inspectionFileMatcher } from './phases.js';

export async function analyzeSnapshot(input: AnalysisInput, additional: readonly Plugin[] = [],
  cache?: OperationCacheOptions, history?: HistoryCache): Promise<Report> {
  const sources = selectAnalysisSources(input.snapshot, additional, input.coverage !== undefined);
  const reusable = history?.begin(input.snapshot, historyProfile(input, sources, cache?.configurationDigest));
  const results = new AnalysisResults(sources.plugins, input.snapshot.oversizedClaims ?? []);
  for (const task of defaultFilePlan(sources)) results.remember(task);

  const batchFacts = await collectRepositorySyntax(sources, results, cache, reusable);
  const parsed = await inspectFiles(sources, batchFacts, results, cache, reusable);
  await inspectRepositories(sources, results, cache);
  await inspectAfterFiles(input, sources, parsed, results, cache);

  return assembleAnalysisReport(input, sources, results);
}
