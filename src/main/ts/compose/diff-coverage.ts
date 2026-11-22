import { execute } from '../core/engine/execute.js';
import { plan } from '../core/engine/plan.js';
import type { Product } from '../core/engine/plugin.js';
import { digest, sourceDirectoriesExcluded, sourceExtensions, sourceLineCounts } from '../core/model/snapshot.js';
import { executeDiffCoverage } from '../core/usecases/diff-coverage.js';
import type { DiffCoveragePorts, DiffCoverageReport } from '../core/usecases/diff-coverage.js';
import { defaultSourceExclusions, generatedSourcePolicy, sourceExclusionMatcher } from '../core/profile/exclusions.js';
import { coverage, lcovInput } from '../plugins/coverage/coverage.js';
import { changesInput, diffCoverage, diffCoverageResult } from '../plugins/coverage/diff-coverage.js';
import { diffMethod, findMergeBase, readChanges } from '../api/git/changes.js';
import { gitText, physicalGitRoot, readGitCommit, resolveGitCommit } from '../api/git/git.js';
import { readLcovFiles } from '../api/import/lcov-files.js';
import type { LcovFiles } from '../api/import/lcov-files.js';

export { diffCoverageSchema } from '../core/usecases/diff-coverage.js';
export type { DiffCoverageReport } from '../core/usecases/diff-coverage.js';

export interface DiffCoverageRequest {
  readonly directory: string;
  readonly revision: string;
  readonly base: string;
  readonly lcov: LcovFiles;
  readonly exclude?: readonly string[];
  readonly minimumPercent?: number;
}

const operation = 'diff-coverage/measure';
const steps = plan({ plugins: [diffCoverage], select: [operation],
  inputs: new Map([['changes', changesInput.id], ['lcov', lcovInput.id]]) });

export async function measureDiffCoverage(request: DiffCoverageRequest, overrides?: Partial<DiffCoveragePorts>): Promise<DiffCoverageReport> {
  return (await measureChangedLines(request, overrides)).report;
}

export async function measureChangedLines(request: DiffCoverageRequest, overrides?: Partial<DiffCoveragePorts>) {
  return executeDiffCoverage(request, {
    readInputs: (excludedPaths, excludes) => readInputs(request, excludedPaths, excludes),
    async measure({ changes, lcovText, root, snapshot }, excludes) {
      const inputs = new Map<string, Product>([
        ['changes', { contract: changesInput.id, value: changes }],
        ['lcov', { contract: lcovInput.id, value: { text: lcovText, root, sourceLines: sourceLineCounts(snapshot.files), excludes } }],
      ]);
      const result = (await execute(steps, inputs)).get(operation);
      if (!result || result.state !== 'completed') throw new Error(result?.reason ?? 'Diff coverage did not run');
      const value = result.product.value;
      if (!diffCoverageResult.accepts(value)) throw new Error('Invalid diff coverage result');
      return value;
    },
    ...overrides,
  });
}

async function readInputs(request: DiffCoverageRequest, excludedPaths: readonly string[], excludes: (path: string) => boolean) {
  const root = await physicalGitRoot(request.directory);
  const [requestedBase, head, lcov, gitVersion] = await Promise.all([
    resolveGitCommit(root, request.base),
    resolveGitCommit(root, request.revision),
    readLcovFiles(request.lcov),
    gitText(root, ['--version']).then(text => text.trim()),
  ]);
  const base = await findMergeBase(root, requestedBase, head);
  const snapshot = await readGitCommit(root, head, excludes);
  const changes = await readChanges(root, base, snapshot, sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded));
  return { requestedBase, base, head, snapshot, changes, root, lcovText: lcov.text, appliedConfig: {
    source: { extensions: sourceExtensions, excludedDirectories: sourceDirectoriesExcluded, excludedPaths,
      defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
    gitDiff: { ...diffMethod, version: gitVersion },
    lcov: { inputDigest: digest(lcov.text), pathBase: root, merge: 'any-hit', importerVersion: coverage.version,
      ...(lcov.inputDigests.length > 1 ? { inputDigests: lcov.inputDigests } : {}) },
    plugin: { id: diffCoverage.id, version: diffCoverage.version, api: diffCoverage.api },
  } };
}
