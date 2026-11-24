import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../engine/plugin.js';
import { normalizeFindingIgnore, partitionFindings } from '../model/finding-ignore.js';
import type { FindingIgnoreRule } from '../model/finding-ignore.js';
import { reportSchema } from '../model/report.js';
import type { Report } from '../model/report.js';
import { digest } from '../model/snapshot.js';
import type { SourceSnapshot } from '../model/source.js';
import { normalizeExclusions, sourceExclusionMatcher } from '../profile/exclusions.js';

export interface AnalysisInput {
  /** The source adapter has already applied the exclusions to this snapshot. */
  readonly snapshot: SourceSnapshot;
  readonly excludedOutput: string | null;
  readonly excludedPaths?: readonly string[];
  readonly coverage?: { readonly text: string; readonly sourceRoot: string };
}

export type AnalysisExecutor = (input: AnalysisInput) => Promise<Report>;

type Excludes = (path: string) => boolean;
interface InspectionSource {
  readonly snapshot: SourceSnapshot;
  readonly root: string;
  readonly excludedOutput: string | null;
  save(report: Report): Promise<void>;
}

interface InspectionCoverage {
  readonly text: string;
  readonly inputDigests: readonly string[];
}

export interface InspectionPorts {
  readSource(excludes: Excludes): Promise<InspectionSource>;
  readonly analyze: AnalysisExecutor;
  readCoverage?(source: Pick<InspectionSource, 'root' | 'snapshot'>): Promise<InspectionCoverage>;
  importFindings?(report: Report, root: string, excludes: Excludes): Promise<Report>;
  recordChurn?(report: Report, root: string, paths: readonly string[]): Promise<Report>;
}

export interface InspectionOptions {
  readonly exclude?: readonly string[];
  readonly ignore?: readonly FindingIgnoreRule[];
}

export async function executeInspection(options: InspectionOptions, ports: InspectionPorts): Promise<Report> {
  const excludedPaths = normalizeExclusions(options.exclude ?? []);
  const ignore = normalizeFindingIgnore(options.ignore ?? []);
  const source = await ports.readSource(sourceExclusionMatcher(excludedPaths));
  const { snapshot, root, excludedOutput } = source;
  const lcov = await ports.readCoverage?.(source);
  const report = await ports.analyze({
    snapshot, excludedOutput, excludedPaths,
    coverage: lcov === undefined ? undefined : { text: lcov.text, sourceRoot: root },
  });
  if (report.subject.kind !== snapshot.subject.kind || report.subject.id !== snapshot.subject.id) {
    throw new Error('Analysis result belongs to a different source snapshot');
  }
  const appliedSource = report.appliedConfig.source;
  if (excludedPaths.length > 0 && (!isRecord(appliedSource) || !isDeepStrictEqual(appliedSource.excludedPaths, excludedPaths))) {
    throw new Error('Analysis result does not record the requested source exclusions');
  }
  const covered = lcov && lcov.inputDigests.length > 1 ? withLcovDigests(report, lcov) : report;
  const findings = ports.importFindings
    ? await ports.importFindings(covered, root, sourceExclusionMatcher(excludedPaths, snapshot.generatedExcluded)) : covered;
  const filtered: Report = ignore.length === 0 ? findings : { ...findings, schema: reportSchema,
    appliedConfig: { ...findings.appliedConfig, findingIgnore: ignore },
    ...(findings.findings === undefined ? {} : partitionFindings(findings.findings, ignore)) };
  const result = snapshot.subject.kind === 'commit' && ports.recordChurn
    ? await ports.recordChurn(filtered, root, snapshot.files.map(file => file.path)) : filtered;
  await source.save(result);
  return result;
}

function withLcovDigests(report: Report, { text, inputDigests }: { text: string; inputDigests: readonly string[] }): Report {
  const coverage = report.appliedConfig.coverage;
  if (!isRecord(coverage) || coverage.inputDigest !== digest(text)) {
    throw new Error('Analysis result does not record the requested LCOV inputs');
  }
  return { ...report, appliedConfig: { ...report.appliedConfig, coverage: { ...coverage, inputDigests } } };
}
