import { resolve } from 'node:path';
import { findMergeBase } from '../api/git/changes.js';
import { gitRoot, resolveGitCommit } from '../api/git/git.js';
import type { PullReview } from '../core/model/pull-review.js';
import type { Report } from '../core/model/report.js';
import type { ReportReader } from '../core/ports/report.js';
import { executeReview } from '../core/usecases/review.js';
import type { ReviewPorts } from '../core/usecases/review.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import { measureChangedLines } from './diff-coverage.js';
import type { DiffCoverageRequest } from './diff-coverage.js';

export { projectReview, reviewExitCode } from '../core/usecases/review.js';

export interface ReviewRequest extends DiffCoverageRequest {
  readonly number?: number;
  readonly minimumLines?: number;
  readonly maxCoverageDrop?: number;
  readonly maxNewIssues?: number;
}

export async function reviewPull(request: ReviewRequest, current: ReportReader, baseline: ReportReader = current): Promise<PullReview> {
  return review(request, {
    readHead: id => readIfAvailable(current, id),
    readBase: id => readIfAvailable(baseline, id),
  });
}

export async function review(request: ReviewRequest & { readonly output?: string }, overrides?: Partial<ReviewPorts>): Promise<PullReview> {
  const store = new LocalReportStore(resolve(request.output ?? resolve(request.directory, '.repometry')));
  const { lcov, goCover } = request;
  return executeReview(request, {
    readHead: id => readIfAvailable(store, id),
    readBase: id => readIfAvailable(store, id),
    async readRevisions() {
      const directory = await gitRoot(request.directory);
      const [head, base] = await Promise.all([resolveGitCommit(directory, request.revision), resolveGitCommit(directory, request.base)]);
      return { head, base, mergeBase: () => findMergeBase(directory, base, head) };
    },
    ...(lcov === undefined && goCover === undefined ? {} : { measureChanged: () => measureChangedLines(request) }),
    ...overrides,
  });
}

async function readIfAvailable(reader: ReportReader, id: string): Promise<Report | null> {
  try {
    return await reader.read({ kind: 'commit', id });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
