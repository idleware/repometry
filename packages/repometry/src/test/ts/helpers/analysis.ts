import { analyzeSnapshot as analyze } from '../../../main/ts/compose/analyze-snapshot.js';
import type { HistoryCache } from '../../../main/ts/compose/history-cache.js';
import { languageRegistry } from '../../../main/ts/compose/languages.js';
import type { OperationCacheOptions } from '../../../main/ts/core/engine/operation-cache.js';
import type { Plugin } from '../../../main/ts/core/engine/plugin.js';
import type { AnalysisInput } from '../../../main/ts/core/usecases/inspect.js';

export async function analyzeSnapshot(input: AnalysisInput, plugins: readonly Plugin[] = [], cache?: OperationCacheOptions,
  history?: HistoryCache, languages = languageRegistry(plugins)) {
  return analyze(input, languages, cache, history);
}
