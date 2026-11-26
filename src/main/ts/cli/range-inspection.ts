import { HistoryCache } from '../compose/history-cache.js';
import { inspectWithOptions } from '../compose/inspect.js';
import type { Report } from '../core/model/report.js';
import type { parseConfig } from './config.js';

export interface RangeInspection {
  readonly directory: string;
  readonly output: string;
  readonly exclude: readonly string[];
}

export type CommitOutcome =
  | { readonly commit: string; readonly state: 'analyzed' | 'partial' }
  | { readonly commit: string; readonly state: 'failed'; readonly error: string };

export type RangeMessage =
  | { readonly kind: 'start'; readonly commits: readonly string[]; readonly inspection: RangeInspection; readonly config: unknown }
  | { readonly kind: 'stop' };

export function rangeInspector(inspection: RangeInspection, config: ReturnType<typeof parseConfig>) {
  const { plugins, ...profile } = config;
  const history = new HistoryCache(profile);
  const { directory, output, exclude } = inspection;
  return (revision: string) => inspectWithOptions({ directory, output, source: { revision }, exclude,
    ignore: config.ignore, plugins }, { history, deferSummary: true });
}

export async function inspectCommits(commits: readonly string[], inspectCommit: (id: string) => Promise<Report>,
  stopped: () => boolean, report: (outcome: CommitOutcome) => void | Promise<void>): Promise<void> {
  for (const commit of commits) {
    if (stopped()) break;
    const outcome = await inspectOne(commit, inspectCommit);
    if (outcome.state === 'failed' && stopped()) break;
    await report(outcome);
  }
}

async function inspectOne(commit: string, inspectCommit: (id: string) => Promise<Report>): Promise<CommitOutcome> {
  try {
    const report = await inspectCommit(commit);
    return { commit, state: report.status === 'partial' ? 'partial' : 'analyzed' };
  } catch (error) {
    return { commit, state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
