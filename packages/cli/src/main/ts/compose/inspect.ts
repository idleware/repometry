import { resolve } from 'node:path';
import { gitTreeFiles } from '../api/git/git.js';
import type { GitSelection } from '../api/git/git.js';
import type { InventoryObserver } from '../api/git/local.js';
import { readInspectionSource } from '../api/git/inspection-source.js';
import { importFindings } from '../api/import/finding-import.js';
import { hasCoverageInputs } from '../api/import/lcov-files.js';
import { readInspectionCoverage } from './inspection-coverage.js';
import type { CoverageInputs } from '../api/import/lcov-files.js';
import type { OperationCacheOptions } from '@repometry/core/internal/engine/operation-cache.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { FindingIgnoreRule } from '@repometry/core/internal/model/finding-ignore.js';
import { reportSchema } from '@repometry/core/internal/model/report.js';
import type { Diagnostic, Report } from '@repometry/core/internal/model/report.js';
import type { FindingInput } from '@repometry/core/internal/model/scanner-import.js';
import { isExcludedDirectory } from '@repometry/core/internal/model/snapshot.js';
import { executeInspection } from '@repometry/core/internal/usecases/inspect.js';
import type { InspectionPorts } from '@repometry/core/internal/usecases/inspect.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import { analyzeSnapshot, inspectionFileMatcher } from './analyze-snapshot.js';
import { attachChurn } from './attach-churn.js';
import type { HistoryCache } from './history-cache.js';
import { languageRegistry } from './languages.js';
import type { ParserOrder } from './parser-order.js';

export interface InspectRequest extends CoverageInputs {
  readonly directory: string;
  readonly output: string;
  readonly source: { readonly workingTree: true } | { readonly revision: string };
  readonly exclude?: readonly string[];
  readonly findingInputs?: readonly FindingInput[];
  readonly findingRoot?: string;
  readonly ignore?: readonly FindingIgnoreRule[];
  /** Trusted in-process plugins. */
  readonly plugins?: readonly Plugin[];
  readonly parsers?: ParserOrder;
  readonly operationCache?: OperationCacheOptions;
}

export function inspect(request: InspectRequest): Promise<Report> {
  return inspectWithOptions(request);
}

export async function inspectWithOptions(request: InspectRequest,
  { history, deferSummary = false, recordChurn = true, inventory }:
    { history?: HistoryCache; deferSummary?: boolean; recordChurn?: boolean; inventory?: InventoryObserver } = {}): Promise<Report> {
  const { findingInputs = [], plugins = [], operationCache } = request;
  const languages = languageRegistry(plugins, request.parsers);
  const claims = inspectionFileMatcher(languages);
  const { isSource } = languages;
  const ports: InspectionPorts = {
    readSource: excludes => readSource(request, { excludes, isSource, claims, history: history?.blobs }, deferSummary, inventory),
    analyze: input => analyzeSnapshot(input, languages, operationCache, history),
    ...(hasCoverageInputs(request) ? { readCoverage: source => readInspectionCoverage(request, source) } : {}),
    ...(findingInputs.length === 0 ? {} : { importFindings: (report, root, excludes) =>
      attachFindings(report, findingInputs, root, request.findingRoot === undefined ? root : resolve(request.findingRoot), excludes) }),
    recordChurn: recordChurn ? (report, root, paths) => attachChurn(report, root, paths.filter(isSource)) : undefined,
  };
  return executeInspection(request, ports);
}

async function readSource(request: InspectRequest, selection: GitSelection, deferSummary: boolean, inventory?: InventoryObserver) {
  const source = await readInspectionSource(request, selection, inventory);
  const store = new LocalReportStore(source.output);
  return { ...source, save: (report: Report) => store.save(report, { deferSummary }) };
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
