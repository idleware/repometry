import type { GitChanges } from '../model/changes.js';
import type { DiffCoverage, DiffCoverageResult } from '../model/diff-coverage.js';
import type { SourceSnapshot } from '../model/source.js';
import { normalizeExclusions, sourceExclusionMatcher } from '../profile/exclusions.js';
import { assessDiffCoverage } from './diff-coverage-policy.js';
import type { CoverageDecision } from './diff-coverage-policy.js';

export const diffCoverageSchema = 'urn:repometry:schema:diff-coverage:1';

export interface DiffCoverageReport extends DiffCoverage {
  readonly schema: typeof diffCoverageSchema;
  readonly requestedBase: string;
  readonly base: string;
  readonly head: string;
  readonly generatedAt: string;
  readonly appliedConfig: Readonly<Record<string, unknown>>;
  readonly decision: CoverageDecision | null;
}

export interface DiffCoverageSource {
  readonly requestedBase: string;
  readonly base: string;
  readonly head: string;
  readonly snapshot: SourceSnapshot;
  readonly changes: GitChanges;
  readonly root: string;
  readonly lcovText: string;
  readonly appliedConfig: Readonly<Record<string, unknown>>;
}

export interface DiffCoveragePorts {
  readInputs(excludedPaths: readonly string[], excludes: (path: string) => boolean): Promise<DiffCoverageSource>;
  measure(source: DiffCoverageSource, excludes: (path: string) => boolean): Promise<DiffCoverageResult>;
}

interface DiffCoverageOptions {
  readonly exclude?: readonly string[];
  readonly minimumPercent?: number;
}

export async function executeDiffCoverage(options: DiffCoverageOptions, ports: DiffCoveragePorts) {
  const excludedPaths = normalizeExclusions(options.exclude ?? []);
  const source = await ports.readInputs(excludedPaths, sourceExclusionMatcher(excludedPaths));
  const value = await ports.measure(source, sourceExclusionMatcher(excludedPaths, source.snapshot.generatedExcluded));
  const { uncovered, ...observation } = value;
  const { requestedBase, base, head, appliedConfig } = source;
  const report: DiffCoverageReport = {
    schema: diffCoverageSchema, requestedBase, base, head, generatedAt: new Date().toISOString(), appliedConfig,
    ...observation, decision: options.minimumPercent === undefined ? null : assessDiffCoverage(value, options.minimumPercent),
  };
  return { report, uncovered };
}
