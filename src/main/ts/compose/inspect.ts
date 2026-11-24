import { resolve } from 'node:path';
import { gitTreeFiles } from '../api/git/git.js';
import { readInspectionSource } from '../api/git/inspection-source.js';
import { importFindings } from '../api/import/finding-import.js';
import { readInspectionCoverage } from './inspection-coverage.js';
import type { LcovFiles } from '../api/import/lcov-files.js';
import type { OperationCacheOptions } from '../core/engine/operation-cache.js';
import type { Plugin } from '../core/engine/plugin.js';
import type { FindingIgnoreRule } from '../core/model/finding-ignore.js';
import { reportSchema } from '../core/model/report.js';
import type { Diagnostic, Report } from '../core/model/report.js';
import type { FindingInput } from '../core/model/scanner-import.js';
import { isExcludedDirectory } from '../core/model/snapshot.js';
import { executeInspection } from '../core/usecases/inspect.js';
import type { AnalysisExecutor, InspectionPorts } from '../core/usecases/inspect.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import { analyzeSnapshot, inspectionFileMatcher } from './analyze-snapshot.js';
import { attachChurn } from './attach-churn.js';
import { languageRegistry } from './languages.js';

export { analyzeSnapshot } from './analyze-snapshot.js';
export type { AnalysisExecutor, AnalysisInput, InspectionPorts } from '../core/usecases/inspect.js';

export interface InspectRequest {
  readonly directory: string;
  readonly output: string;
  readonly source: { readonly workingTree: true } | { readonly revision: string };
  readonly lcov?: LcovFiles;
  readonly goCover?: LcovFiles;
  readonly exclude?: readonly string[];
  readonly findingInputs?: readonly FindingInput[];
  readonly findingRoot?: string;
  readonly ignore?: readonly FindingIgnoreRule[];
  /** Trusted in-process plugins for the default executor. */
  readonly plugins?: readonly Plugin[];
  readonly operationCache?: OperationCacheOptions;
}

export async function inspect(request: InspectRequest, overrides?: AnalysisExecutor | Partial<InspectionPorts>): Promise<Report> {
  const { lcov, goCover, findingInputs = [], plugins = [], operationCache } = request;
  if ((plugins.length || operationCache) && (typeof overrides === 'function' || overrides?.analyze)) {
    throw new Error('Configure plugins and the operation cache on the custom executor');
  }
  const languages = languageRegistry(plugins);
  const claims = inspectionFileMatcher(plugins, languages);
  const { isSource } = languages;
  const ports: InspectionPorts = {
    readSource: excludes => readSource(request, excludes, isSource, claims),
    analyze: input => analyzeSnapshot(input, plugins, operationCache),
    ...(lcov === undefined && goCover === undefined ? {} : { readCoverage: source => readInspectionCoverage({ lcov, goCover }, source) }),
    ...(findingInputs.length === 0 ? {} : { importFindings: (report, root, excludes) =>
      attachFindings(report, findingInputs, root, request.findingRoot === undefined ? root : resolve(request.findingRoot), excludes) }),
    recordChurn: (report, root, paths) => attachChurn(report, root, paths.filter(isSource)),
    ...(typeof overrides === 'function' ? { analyze: overrides } : overrides),
  };
  return executeInspection(request, ports);
}

async function readSource(request: InspectRequest, excludes: (path: string) => boolean, isSource: (path: string) => boolean,
  claims: (path: string) => boolean) {
  const source = await readInspectionSource(request, excludes, isSource, claims);
  const store = new LocalReportStore(source.output);
  return { ...source, save: (report: Report) => store.save(report) };
}

export async function attachFindings(report: Report, inputs: readonly FindingInput[], root: string, findingRoot: string,
  excludes: (path: string) => boolean): Promise<Report> {
  const known = report.subject.kind === 'commit'
    ? new Set((await gitTreeFiles(root, report.subject.id)).map(entry => entry.path)) : undefined;
  const isExcluded = (path: string) => path.split('/').slice(0, -1).some(isExcludedDirectory) || excludes(path);
  const imports = await Promise.all(inputs.map(input => importFindings(input, findingRoot, isExcluded, known)));
  const findingImports = imports.map(({ metadata }) => metadata);
  const gaps: Diagnostic[] = findingImports.filter(({ unmapped }) => unmapped > 0).map(({ category, format, unmapped }) => ({
    operation: `findings/${category}/${format}`, state: 'partial', message: `${unmapped} finding locations could not be mapped to the source`,
  }));
  const findings = [...report.findings ?? [], ...imports.flatMap(({ findings }) => findings)];
  // Import provenance identifies the normalized finding set and does not store an analyzer's raw report or host path.
  return { ...report, schema: reportSchema, findings, appliedConfig: { ...report.appliedConfig, findingImports },
    status: gaps.length > 0 ? 'partial' : report.status === 'not-applicable' && findingImports.some(item => item.units > 0)
      ? 'complete' : report.status, diagnostics: [...report.diagnostics, ...gaps] };
}
