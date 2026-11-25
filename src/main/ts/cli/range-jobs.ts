import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { LocalReportStore } from '../report/json/store/local-store.js';
import { inspectCommits, rangeInspector } from './range-inspection.js';
import type { CommitOutcome, RangeInspection, RangeMessage } from './range-inspection.js';
import type { parseConfig } from './config.js';

const minimumChunkSize = 25;
const workerMemoryBytes = 512 * 1024 * 1024;
type Outcome = CommitOutcome | { readonly commit: string; readonly state: 'skipped' };

export function historyChunks(commits: readonly string[], concurrency: number, memory: number): readonly (readonly string[])[] {
  if (commits.length === 0) return [];
  const workers = Math.max(1, Math.min(concurrency, Math.floor(memory / workerMemoryBytes), Math.floor(commits.length / minimumChunkSize)));
  const size = Math.floor(commits.length / workers);
  const remainder = commits.length % workers;
  return Array.from({ length: workers }, (_, index) => {
    const start = index * size + Math.min(index, remainder);
    return commits.slice(start, start + size + Number(index < remainder));
  });
}

interface RangeOptions {
  readonly inspection: RangeInspection;
  readonly config: ReturnType<typeof parseConfig>;
  readonly configValue: unknown;
  readonly concurrency?: number;
  readonly skipSaved: boolean;
}

export async function analyzeCommits(commits: readonly string[], options: RangeOptions) {
  const { inspection, config, configValue, concurrency, skipSaved } = options;
  const inspectCommit = rangeInspector(inspection, config);
  const outcomes = new Map<string, Outcome>();
  const control = new AbortController();
  const { signal } = control;
  const stop = () => {
    if (signal.aborted) return;
    control.abort();
    process.stderr.write('Stopping after the current commit in each worker.\n');
  };
  process.on('SIGINT', stop);
  const width = String(commits.length).length;
  const record = (outcome: Outcome) => {
    outcomes.set(outcome.commit, outcome);
    const state = outcome.state === 'failed' ? `failed: ${outcome.error}` : outcome.state;
    process.stderr.write(`[${String(outcomes.size).padStart(width)}/${commits.length}] ${outcome.commit.slice(0, 7)} ${state}\n`);
  };
  try {
    const pending = await pendingCommits(commits, inspection.output, skipSaved, signal, record);
    // The remote worker accepts one request at a time.
    const workers = inspection.worker === undefined ? concurrency ?? availableParallelism() : 1;
    const chunks = historyChunks(pending, workers, process.availableMemory());
    if (!signal.aborted && chunks.length === 1) {
      await inspectCommits(chunks[0]!, inspectCommit, () => signal.aborted, record);
    } else if (!signal.aborted) {
      await Promise.all(chunks.map(chunk => runChunk(chunk, inspection, configValue, signal, record)));
    }
    const results = collectOutcomes(commits, outcomes);
    if (results.analyzed.length || results.skipped.length) {
      await new LocalReportStore(await realpath(inspection.output)).refreshSummary();
    }
    return { ...results, interrupted: signal.aborted };
  } finally {
    process.removeListener('SIGINT', stop);
  }
}

async function pendingCommits(commits: readonly string[], store: string, skipSaved: boolean, signal: AbortSignal,
  record: (outcome: Outcome) => void): Promise<readonly string[]> {
  if (!skipSaved) return commits;
  const pending: string[] = [];
  for (const commit of commits) {
    if (signal.aborted) break;
    if (await isSaved(store, commit)) record({ commit, state: 'skipped' });
    else pending.push(commit);
  }
  return pending;
}

export async function isSaved(store: string, id: string): Promise<boolean> {
  try {
    return (await lstat(join(store, 'commits', id, 'report.json'))).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function collectOutcomes(commits: readonly string[], outcomes: ReadonlyMap<string, Outcome>) {
  const analyzed: string[] = [], partial: string[] = [], skipped: string[] = [];
  const failed: { commit: string; error: string }[] = [];
  for (const commit of commits) {
    const outcome = outcomes.get(commit);
    switch (outcome?.state) {
      case 'partial': partial.push(commit);
      // Partial analysis still leaves a saved report.
      case 'analyzed': analyzed.push(commit); break;
      case 'skipped': skipped.push(commit); break;
      case 'failed': failed.push({ commit, error: outcome.error }); break;
    }
  }
  return { analyzed, partial, skipped, failed };
}

async function runChunk(commits: readonly string[], inspection: RangeInspection, config: unknown, signal: AbortSignal,
  record: (outcome: CommitOutcome) => void): Promise<void> {
  const pending = new Set(commits);
  try {
    // A terminal interrupt reaches the coordinator. Workers finish their current Git and analyzer subprocesses.
    const worker = fork(new URL('./range-worker.js', import.meta.url), [], {
      detached: process.platform !== 'win32', execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const message: RangeMessage = { kind: 'start', commits, inspection, config };
    await runWorker(worker, message, signal, outcome => {
      if (pending.delete(outcome.commit)) record(outcome);
    });
    failPending('Range worker exited before reporting the remaining commits');
  } catch (error) {
    failPending(error instanceof Error ? error.message : String(error));
  }

  function failPending(error: string): void {
    if (!signal.aborted) for (const commit of pending) record({ commit, state: 'failed', error });
  }
}

function runWorker(worker: ChildProcess, message: RangeMessage, signal: AbortSignal,
  record: (outcome: CommitOutcome) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      const interrupt: RangeMessage = { kind: 'stop' };
      if (worker.connected) worker.send(interrupt, () => {});
    };
    worker.on('message', record);
    worker.once('error', reject);
    worker.once('close', (code, cause) => {
      signal.removeEventListener('abort', stop);
      if (code === 0 || signal.aborted) resolve();
      else reject(new Error(`Range worker exited with ${cause ?? code}`));
    });
    worker.send(message, error => { if (error && !signal.aborted) reject(error); });
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
