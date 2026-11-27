import { execute } from '../core/engine/execute.js';
import { plan } from '../core/engine/plan.js';
import type { Plugin, Product } from '../core/engine/plugin.js';
import { digest, sourceDirectoriesExcluded, sourceLineCounts } from '../core/model/snapshot.js';
import { executeDiffCoverage } from '../core/usecases/diff-coverage.js';
import type { DiffCoveragePorts, DiffCoverageReport } from '../core/usecases/diff-coverage.js';
import { defaultSourceExclusions, generatedSourcePolicy, sourceExclusionMatcher } from '../core/profile/exclusions.js';
import { changesInput } from '../core/model/changes.js';
import { lcovInput } from '../core/model/coverage-input.js';
import { diffCoverageResult } from '../core/model/diff-coverage.js';
import type { DiffCoverageResult } from '../core/model/diff-coverage.js';
import { builtInPlugins } from './built-ins.js';
import { candidatesOf, diffCoveragePhases, phaseInputs, selectOperations } from './phases.js';
import { diffMethod, findMergeBase, readChanges } from '../api/git/changes.js';
import { gitText, physicalGitRoot, readGitCommit, resolveGitCommit } from '../api/git/git.js';
import { readInspectionCoverage } from './inspection-coverage.js';
import type { CoverageInputs } from '../api/import/lcov-files.js';
import { defaultLanguages, languageRegistry } from './languages.js';
import type { ParserOrder } from './parser-order.js';

export { diffCoverageSchema } from '../core/usecases/diff-coverage.js';
export type { DiffCoverageReport } from '../core/usecases/diff-coverage.js';

export interface DiffCoverageRequest extends CoverageInputs {
  readonly directory: string;
  readonly revision: string;
  readonly base: string;
  readonly exclude?: readonly string[];
  readonly minimumPercent?: number;
  readonly plugins?: readonly Plugin[];
  readonly parsers?: ParserOrder;
}

const { changedLines } = selectOperations(builtInPlugins, diffCoveragePhases, new Set(defaultLanguages.providers.map(({ key }) => key)));
const { plugin: measurer, key: operation } = changedLines.find(({ operation }) => operation.output === diffCoverageResult)!;
// The result records the version of the import-kind plugin that reads the coverage input.
const { plugin: importer } = changedLines.find(({ plugin, operation }) => plugin.kinds.includes('import')
  && Object.values(operation.inputs).includes(lcovInput))!;
const steps = plan({ plugins: candidatesOf(changedLines), select: [operation], inputs: phaseInputs(diffCoveragePhases.changedLines) });

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
      return result.product.value as DiffCoverageResult; // execute() checked it against the contract
    },
    ...overrides,
  });
}

async function readInputs(request: DiffCoverageRequest, excludedPaths: readonly string[], excludes: (path: string) => boolean) {
  const root = await physicalGitRoot(request.directory);
  const [requestedBase, head, gitVersion] = await Promise.all([
    resolveGitCommit(root, request.base),
    resolveGitCommit(root, request.revision),
    gitText(root, ['--version']).then(text => text.trim()),
  ]);
  const base = await findMergeBase(root, requestedBase, head);
  const { isSource, extensions, globs } = languageRegistry(request.plugins ?? [], true, request.parsers);
  const snapshot = await readGitCommit(root, head, { excludes, isSource });
  const [lcov, changes] = await Promise.all([
    readInspectionCoverage(request, { root, snapshot }),
    readChanges(root, base, snapshot, sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded), isSource),
  ]);
  return { requestedBase, base, head, snapshot, changes, root, lcovText: lcov.text, appliedConfig: {
    source: { extensions, ...(globs.length ? { globs } : {}), excludedDirectories: sourceDirectoriesExcluded, excludedPaths,
      defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
    gitDiff: { ...diffMethod, version: gitVersion },
    lcov: { inputDigest: digest(lcov.text), pathBase: root, merge: 'any-hit', importerVersion: importer.version,
      ...(lcov.inputDigests.length > 1 ? { inputDigests: lcov.inputDigests } : {}) },
    plugin: { id: measurer.id, version: measurer.version, api: measurer.api },
  } };
}
