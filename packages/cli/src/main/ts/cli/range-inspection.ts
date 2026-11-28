import { HistoryCache } from '../compose/history-cache.js';
import { inspectWithOptions } from '../compose/inspect.js';
import { detectMissingLanguages } from '../compose/language-discovery.js';
import type { MissingLanguagePlugin } from '../compose/language-discovery.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import type { loadConfig } from './config.js';

export interface RangeInspection {
  readonly directory: string;
  readonly output: string;
  readonly exclude: readonly string[];
}

export type CommitOutcome =
  | { readonly commit: string; readonly state: 'analyzed' | 'partial'; readonly missingLanguagePlugins: readonly MissingLanguagePlugin[] }
  | { readonly commit: string; readonly state: 'failed'; readonly error: string };

export interface RangeConfiguration {
  readonly value: unknown;
  readonly root: string;
  readonly file: string | undefined;
  readonly distributionModule?: string;
}

export type RangeMessage =
  | { readonly kind: 'start'; readonly commits: readonly string[]; readonly inspection: RangeInspection; readonly configuration: RangeConfiguration }
  | { readonly kind: 'stop' };

export function rangeInspector(inspection: RangeInspection, config: Awaited<ReturnType<typeof loadConfig>>) {
  const { plugins, ...profile } = config;
  const history = new HistoryCache(profile);
  const { directory, output, exclude } = inspection;
  return async (revision: string): Promise<ObservedCommit> => {
    const inventory = detectMissingLanguages(plugins);
    const report = await inspectWithOptions({ directory, output, source: { revision }, exclude,
      ignore: config.ignore, plugins, parsers: config.parsers }, { history, deferSummary: true, inventory });
    return { report, missingLanguagePlugins: inventory.results() };
  };
}

interface ObservedCommit {
  readonly report: Report;
  readonly missingLanguagePlugins: readonly MissingLanguagePlugin[];
}

export async function inspectCommits(commits: readonly string[], inspectCommit: (id: string) => Promise<ObservedCommit>,
  stopped: () => boolean, report: (outcome: CommitOutcome) => void | Promise<void>): Promise<void> {
  for (const commit of commits) {
    if (stopped()) break;
    const outcome = await inspectOne(commit, inspectCommit);
    if (outcome.state === 'failed' && stopped()) break;
    await report(outcome);
  }
}

async function inspectOne(commit: string, inspectCommit: (id: string) => Promise<ObservedCommit>): Promise<CommitOutcome> {
  try {
    const { report, missingLanguagePlugins } = await inspectCommit(commit);
    return { commit, state: report.status === 'partial' ? 'partial' : 'analyzed', missingLanguagePlugins };
  } catch (error) {
    return { commit, state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
