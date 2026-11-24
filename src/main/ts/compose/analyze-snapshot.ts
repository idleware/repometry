import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import type { Plugin } from '../core/engine/plugin.js';
import type { Report } from '../core/model/report.js';
import type { AnalysisInput } from '../core/usecases/inspect.js';
import { defaultFilePlan, inspectFiles } from './analysis-files.js';
import { importAnalysisCoverage, inspectDuplication } from './analysis-imports.js';
import { collectRepositorySyntax, inspectRepositories } from './analysis-repository.js';
import { assembleAnalysisReport } from './analysis-report.js';
import { AnalysisResults } from './analysis-results.js';
import { selectAnalysisSources } from './analysis-sources.js';
import { historyProfile } from './history-cache.js';
import type { HistoryCache } from './history-cache.js';

export { inspectionFileMatcher } from './analysis-sources.js';

export async function analyzeSnapshot(input: AnalysisInput, additional: readonly Plugin[] = [],
  cache?: OperationCacheOptions, history?: HistoryCache): Promise<Report> {
  const withCoverage = input.coverage !== undefined;
  const sources = selectAnalysisSources(input.snapshot, additional, withCoverage);
  const reusable = history?.begin(input.snapshot, historyProfile(input, sources, cache?.configurationDigest));
  const results = new AnalysisResults(sources.plugins, sources.claimedPlugins, input.snapshot.oversizedClaims ?? []);
  for (const task of defaultFilePlan) results.remember(task);

  const batchFacts = await collectRepositorySyntax(sources, results, cache, reusable);
  const files = await inspectFiles(sources, batchFacts, results, withCoverage, cache, reusable);
  await inspectRepositories(sources, results, cache);
  await inspectDuplication(files, results, cache);
  await importAnalysisCoverage(input, sources, files, results, cache);

  return assembleAnalysisReport(input, sources, results);
}
