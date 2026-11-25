import { remoteExecutor } from '../api/worker/remote-executor.js';
import { workerToken } from '../api/worker/worker-protocol.js';
import { HistoryCache } from '../compose/history-cache.js';
import { inspect } from '../compose/inspect.js';
import { languageRegistry } from '../compose/languages.js';
import type { Plugin } from '../core/engine/plugin.js';
import type { Report } from '../core/model/report.js';
import type { parseConfig } from './config.js';

export interface RangeInspection {
  readonly directory: string;
  readonly output: string;
  readonly exclude: readonly string[];
  readonly worker?: string;
}

export type CommitOutcome =
  | { readonly commit: string; readonly state: 'analyzed' | 'partial' }
  | { readonly commit: string; readonly state: 'failed'; readonly error: string };

export type RangeMessage =
  | { readonly kind: 'start'; readonly commits: readonly string[]; readonly inspection: RangeInspection; readonly config: unknown }
  | { readonly kind: 'stop' };

export function analysisExecutor(worker: string | undefined, plugins: readonly Plugin[]) {
  if (worker === undefined) return undefined;
  if (plugins.length) throw new Error('Configured process plugins require local analysis. Use --no-config with --worker.');
  return remoteExecutor(worker, workerToken(), languageRegistry([]).isSource);
}

export function rangeInspector(inspection: RangeInspection, config: ReturnType<typeof parseConfig>) {
  const { plugins, ...profile } = config;
  const executor = analysisExecutor(inspection.worker, plugins);
  const history = executor === undefined ? new HistoryCache(profile) : undefined;
  const { directory, output } = inspection;
  const exclude = [...config.exclude, ...inspection.exclude];
  return (revision: string) => inspect({ directory, output, source: { revision }, exclude,
    ignore: config.ignore, plugins }, executor, { history, deferSummary: true });
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
