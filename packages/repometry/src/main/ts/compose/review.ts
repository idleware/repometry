import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMergeBase } from '../api/git/changes.js';
import { GitBlobReader, resolveGitCommit } from '../api/git/git.js';
import { readLineChanges } from '../api/git/line-changes.js';
import { hasCoverageInputs } from '../api/import/lcov-files.js';
import type { CoverageInputs } from '../api/import/lcov-files.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { LineChanges } from '@repometry/core/internal/model/changes.js';
import type { FindingIgnoreRule } from '@repometry/core/internal/model/ignore-rule.js';
import type { PullReview } from '@repometry/core/internal/model/pull-review.js';
import { checkOptions, projectReview } from '@repometry/core/internal/usecases/review.js';
import type { ReviewOptions } from '@repometry/core/internal/usecases/review.js';
import type { SourceLines } from '@repometry/core/internal/usecases/review-effect.js';
import { measureChangedLines } from './diff-coverage.js';
import { HistoryCache } from './history-cache.js';
import { inspectWithOptions } from './inspect.js';
import type { ParserOrder } from './parser-order.js';

export { projectReview, reviewExitCode, reviewReason } from '@repometry/core/internal/usecases/review.js';

export interface ReviewRequest extends ReviewOptions, CoverageInputs {
  /** The repository root. */
  readonly directory: string;
  readonly base: string;
  readonly revision?: string;
  readonly exclude?: readonly string[];
  readonly ignore?: readonly FindingIgnoreRule[];
  readonly plugins?: readonly Plugin[];
  readonly parsers?: ParserOrder;
  /** The settings that shaped both inspections, which keeps the second one's reuse of unchanged files honest. */
  readonly settings?: unknown;
  /** The settings file's repository path; a change to it is noted. */
  readonly settingsPath?: string;
}

/**
 * Analyses the merge base and the head with the same settings, in a temporary store, and reports what the change did
 * on the lines it changed. The repository's own store is neither read nor written.
 */
export async function review(request: ReviewRequest): Promise<PullReview> {
  const { directory, lcov, goCover, cobertura, exclude, ignore, plugins, parsers } = request;
  const inputs = { lcov, goCover, cobertura };
  const withCoverage = hasCoverageInputs(inputs);
  checkOptions(request, withCoverage);
  const [head, requested] = await Promise.all([resolveGitCommit(directory, request.revision ?? 'HEAD'),
    resolveGitCommit(directory, request.base).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. A review needs the base's history: fetch it, `
        + 'for example with fetch-depth: 0 on actions/checkout.', { cause: error });
    })]);
  const mergeBase = await findMergeBase(directory, requested, head);
  const output = await mkdtemp(join(tmpdir(), 'repometry-review-'));
  try {
    const history = new HistoryCache(request.settings);
    const inspectCommit = (id: string, coverage: boolean) => inspectWithOptions({ directory, output, source: { revision: id }, exclude, ignore, plugins, parsers,
      ...coverage ? inputs : {} }, { history, deferSummary: true, recordChurn: false });
    const base = await inspectCommit(mergeBase, false);
    const headReport = await inspectCommit(head, true);
    const changes = await readLineChanges(directory, mergeBase, head);
    const coverage = withCoverage
      ? await measureChangedLines({ directory, base: mergeBase, revision: head, ...inputs, exclude, plugins, parsers }) : null;
    const sources = { base: await sourceLines(directory, mergeBase, changes, 'previous'), head: await sourceLines(directory, head, changes, 'path') };
    const settingsChanged = request.settingsPath !== undefined
      && changes.files.some(file => file.path === request.settingsPath || file.previous === request.settingsPath);
    return projectReview(request, { requestedBase: request.base, base, head: headReport, changes, sources, coverage, settingsChanged });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

/** The text of one side's changed files, which scope and matching read line by line. */
async function sourceLines(directory: string, commit: string, changes: LineChanges, side: 'path' | 'previous'): Promise<SourceLines> {
  const paths = changes.files.flatMap(file => file[side] === null || file.whole ? [] : [file[side]!]);
  const blobs = await new GitBlobReader(directory).read(paths.map(path => `${commit}:${path}`));
  const texts = new Map(paths.map((path, index) => [path, blobs[index]?.toString('utf8').split('\n').map(line => line.replace(/\r$/, ''))]));
  return { line: (path, line) => line >= 1 ? texts.get(path)?.[line - 1] : undefined };
}
