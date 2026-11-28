import { execute } from '@repometry/core/internal/engine/execute.js';
import { plan } from '@repometry/core/internal/engine/plan.js';
import type { Plugin, Product } from '@repometry/core/internal/engine/plugin.js';
import { digest, sourceDirectoriesExcluded, sourceLineCounts } from '@repometry/core/internal/model/snapshot.js';
import type { FindingIgnoreRule, RecordedFindingIgnore } from '@repometry/core/internal/model/ignore-rule.js';
import { coverageIgnore, readIgnoreRules, recordIgnoreRules } from '@repometry/core/internal/profile/ignore.js';
import { executeDiffCoverage } from '@repometry/core/internal/usecases/diff-coverage.js';
import type { DiffCoveragePorts, DiffCoverageReport } from '@repometry/core/internal/usecases/diff-coverage.js';
import { defaultSourceExclusions, generatedSourcePolicy, sourceExclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import { changesInput } from '@repometry/core/internal/model/changes.js';
import { lcovInput } from '@repometry/core/internal/model/coverage-input.js';
import { diffCoverageResult } from '@repometry/core/internal/model/diff-coverage.js';
import type { DiffCoverageResult } from '@repometry/core/internal/model/diff-coverage.js';
import { builtInPluginIds, builtInPlugins, registeredPlugins } from './built-ins.js';
import { candidatesOf, diffCoveragePhases, phaseInputs, selectOperations } from './phases.js';
import { diffMethod, findMergeBase, readChanges } from '../api/git/changes.js';
import { gitText, physicalGitRoot, readGitCommit, resolveGitCommit } from '../api/git/git.js';
import { readInspectionCoverage } from './inspection-coverage.js';
import type { CoverageInputs } from '../api/import/lcov-files.js';
import { claimMatcher, defaultLanguages, languageRegistry } from './languages.js';
import { pluginScope, scopedMatcher } from './plugin-scope.js';
import type { ParserOrder } from './parser-order.js';

export { diffCoverageSchema } from '@repometry/core/internal/usecases/diff-coverage.js';
export type { DiffCoverageReport } from '@repometry/core/internal/usecases/diff-coverage.js';

export interface DiffCoverageRequest extends CoverageInputs {
  readonly directory: string;
  readonly revision: string;
  readonly base: string;
  readonly exclude?: readonly string[];
  readonly ignore?: readonly FindingIgnoreRule[];
  readonly minimumPercent?: number;
  readonly plugins?: readonly Plugin[];
  readonly parsers?: ParserOrder;
}

const { changedLines } = selectOperations(builtInPlugins, diffCoveragePhases, new Set(defaultLanguages.providers.map(({ key }) => key)));
const { plugin: measurer, key: operation } = changedLines.find(({ operation }) => operation.output === diffCoverageResult)!;
// The result records the version of the import-kind plugin that reads the coverage input.
const { plugin: importer } = changedLines.find(({ plugin, operation }) => plugin.kinds.includes('import')
  && Object.values(operation.inputs).includes(lcovInput))!;
const steps = diffPlan(changedLines);

function diffPlan(operations: typeof changedLines) {
  const scope = new Map(operations.map(({ plugin }) => [plugin.id, scopedMatcher(plugin, claimMatcher(plugin.claims))]));
  return plan({ plugins: candidatesOf(operations, scope), select: [operation], inputs: phaseInputs(diffCoveragePhases.changedLines) });
}

function coveragePlan(plugins: readonly Plugin[] = []) {
  if (!plugins.some(plugin => builtInPluginIds.has(plugin.id) && pluginScope(plugin))) return steps;
  const registered = registeredPlugins(plugins).filter(plugin => builtInPluginIds.has(plugin.id));
  return diffPlan(selectOperations(registered, diffCoveragePhases, new Set(defaultLanguages.providers.map(({ key }) => key))).changedLines);
}

export async function measureDiffCoverage(request: DiffCoverageRequest, overrides?: Partial<DiffCoveragePorts>): Promise<DiffCoverageReport> {
  return (await measureChangedLines(request, overrides)).report;
}

export async function measureChangedLines(request: DiffCoverageRequest, overrides?: Partial<DiffCoveragePorts>) {
  const rules = recordIgnoreRules(readIgnoreRules(request.ignore ?? [])).filter(({ category }) => category === 'coverage');
  const ignores = coverageIgnore(rules);
  return executeDiffCoverage(request, {
    readInputs: (excludedPaths, excludes) => readInputs(request, excludedPaths, excludes, rules, ignores),
    async measure({ changes, lcovText, root, snapshot }, excludes) {
      const inputs = new Map<string, Product>([
        ['changes', { contract: changesInput.id, value: changes }],
        ['lcov', { contract: lcovInput.id, value: { text: lcovText, root, sourceLines: sourceLineCounts(snapshot.files), excludes: combine(excludes, ignores) } }],
      ]);
      const result = (await execute(coveragePlan(request.plugins), inputs)).get(operation);
      if (!result || result.state !== 'completed') throw new Error(result?.reason ?? 'Diff coverage did not run');
      return result.product.value as DiffCoverageResult; // execute() checked it against the contract
    },
    ...overrides,
  });
}

type Matches = (path: string) => boolean;

function combine(source: Matches, ignores: Matches | undefined): Matches {
  return ignores ? path => source(path) || ignores(path) : source;
}

async function readInputs(request: DiffCoverageRequest, excludedPaths: readonly string[], excludes: Matches,
  rules: readonly RecordedFindingIgnore[], ignores: Matches | undefined) {
  const root = await physicalGitRoot(request.directory);
  const [requestedBase, head, gitVersion] = await Promise.all([
    resolveGitCommit(root, request.base),
    resolveGitCommit(root, request.revision),
    gitText(root, ['--version']).then(text => text.trim()),
  ]);
  const base = await findMergeBase(root, requestedBase, head);
  const { isSource, extensions, globs } = languageRegistry(request.plugins ?? [], request.parsers);
  const snapshot = await readGitCommit(root, head, { excludes, isSource });
  const [lcov, changes] = await Promise.all([
    readInspectionCoverage(request, { root, snapshot }),
    readChanges(root, base, snapshot, combine(sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded), ignores), isSource),
  ]);
  return { requestedBase, base, head, snapshot, changes, root, lcovText: lcov.text, appliedConfig: {
    source: { extensions, ...(globs.length ? { globs } : {}), excludedDirectories: sourceDirectoriesExcluded, excludedPaths,
      defaultExclusions: defaultSourceExclusions, generatedSourcePolicy, generatedExcluded: snapshot.generatedExcluded ?? [] },
    gitDiff: { ...diffMethod, version: gitVersion },
    lcov: { inputDigest: digest(lcov.text), pathBase: root, merge: 'any-hit', importerVersion: importer.version,
      ...(lcov.inputDigests.length > 1 ? { inputDigests: lcov.inputDigests } : {}) },
    plugin: { id: measurer.id, version: measurer.version, api: measurer.api },
    ...(rules.length === 0 ? {} : { findingIgnore: rules }),
  } };
}
