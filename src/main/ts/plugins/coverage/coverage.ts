import { posix, win32 } from 'node:path';
import reportSchema from '../../../resources/report/json/report-v2.schema.json' with { type: 'json' };
import { isRecord, pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, MetricDescriptor, Plugin } from '../../core/engine/plugin.js';
import { comparePaths } from '../../core/model/snapshot.js';
import { definitions, measurements } from '../../core/model/measurement.js';
import type { Measurement } from '../../core/model/measurement.js';
import { lcovLines } from '../../core/model/line-coverage.js';
import type { FileLineCoverage, FunctionCallCount, HitRun, LineCoverage } from '../../core/model/line-coverage.js';
import type { SourceLineRange } from '../../core/model/source.js';

export interface CoverageInput {
  readonly text: string;
  readonly root: string;
  readonly sourceLines: ReadonlyMap<string, number>;
  readonly codeLines?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly functionBodies?: ReadonlyMap<string, readonly SourceLineRange[]>;
  readonly excludes?: (path: string) => boolean;
}

interface CoverageResult {
  readonly measurements: readonly Measurement[];
  readonly gaps: readonly { readonly path: string; readonly reason: string }[];
  readonly lineCoverage: LineCoverage;
}

export const lcovInput: DataContract<CoverageInput> = {
  id: 'repometry.lcov-input/v1',
  accepts: (value): value is CoverageInput => isRecord(value) && typeof value.text === 'string'
    && typeof value.root === 'string' && value.sourceLines instanceof Map
    && (value.codeLines === undefined || value.codeLines instanceof Map)
    && (value.functionBodies === undefined || value.functionBodies instanceof Map)
    && (value.excludes === undefined || typeof value.excludes === 'function'),
};

export const coverageResult: DataContract<CoverageResult> = {
  id: 'repometry.coverage-result/v1',
  accepts: (value): value is CoverageResult => isRecord(value) && measurements.accepts(value.measurements)
    && Array.isArray(value.gaps) && value.gaps.every(gap => isRecord(gap) && typeof gap.path === 'string' && typeof gap.reason === 'string')
    && lcovLines.accepts(value.lineCoverage),
};

const kinds = [
  { ids: [definitions.coverage, definitions.coveredLines, definitions.coverableLines],
    labels: ['Line coverage', 'Covered lines', 'Measured lines'], includeEmpty: true },
  { ids: [definitions.branchCoverage, definitions.coveredBranches, definitions.coverableBranches],
    labels: ['Branch coverage', 'Covered branches', 'Measured branches'] },
  { ids: [definitions.functionCoverage, definitions.coveredFunctions, definitions.coverableFunctions],
    labels: ['Function coverage', 'Covered functions', 'Measured functions'] },
] as const;
const [lineMetrics, branchMetrics, functionMetrics] = kinds;

export const coverage: Plugin = {
  id: 'lcov',
  version: '1.2.0',
  api: pluginApi,
  kinds: ['coverage', 'import'],
  produces: [{ contract: coverageResult.id, persistence: 'report',
    metrics: kinds.flatMap<MetricDescriptor>(({ ids: [id, of, over], labels }) => [
      { id, label: labels[0], unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
        ratio: { of, over }, bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage' },
      { id: of, label: labels[1], unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
      { id: over, label: labels[2], unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
    ]) }, { contract: lcovLines.id, persistence: 'report',
    schema: { ...reportSchema.$defs.lcovLines,
      $defs: { lcovLineRanges: reportSchema.$defs.lcovLineRanges, lcovHitRuns: reportSchema.$defs.lcovHitRuns,
        lcovFunctionCalls: reportSchema.$defs.lcovFunctionCalls } } }],
  operations: [{
    id: 'import',
    role: 'inspection',
    inputs: { report: lcovInput },
    output: coverageResult,
    execute: inputs => importCoverage(inputs.read('report', lcovInput)),
  }, {
    id: 'lines',
    role: 'inspection',
    inputs: { coverage: coverageResult },
    output: lcovLines,
    execute: inputs => inputs.read('coverage', coverageResult).lineCoverage,
  }],
};

export function mapCoverage({ text, root, sourceLines, codeLines, excludes }: CoverageInput) {
  const files = new Map<string, Map<number, number>>();
  // Branches by line, block and branch. Functions by name and its occurrence in the record: tools such as c8 repeat a
  // name for different functions and list FNDA in FN order.
  const branches = new Map<string, Map<string, number>>();
  const functions = new Map<string, Map<string, number>>();
  const called = new Map<string, Map<string, number>>();
  const occurrences = { declared: new Map<string, number>(), called: new Map<string, number>() };
  const occurrence = (seen: Map<string, number>, name: string) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return `${name}#${count}`;
  };
  const gaps = new Map<string, string>();
  let active: string | undefined;
  let ignored = false;
  let sawSource = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.startsWith('SF:')) {
      if (active !== undefined || line.length === 3) throw new Error(`Unexpected LCOV source at line ${index + 1}`);
      active = normalizeLcovPath(root, line.slice(3));
      occurrences.declared.clear();
      occurrences.called.clear();
      sawSource = true;
      ignored = excludes?.(active) ?? false;
      if (ignored) continue;
      if (!sourceLines.has(active)) gaps.set(active, 'LCOV source is outside the inspected file set');
      else if (codeLines && !codeLines.has(active)) gaps.set(active, 'LCOV source has no classified code lines');
      else fileRecords(files, active);
    } else if (line.startsWith('DA:')) {
      if (active === undefined) throw new Error(`LCOV line data outside a source record at line ${index + 1}`);
      if (ignored) continue;
      const match = /^DA:([1-9]\d*),(\d+)(?:,[^,]+)?$/.exec(line);
      const number = Number(match?.[1]);
      const hits = Number(match?.[2]);
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(hits)) throw new Error(`Invalid LCOV line data at line ${index + 1}`);
      const file = files.get(active);
      const limit = sourceLines.get(active);
      if (limit !== undefined && number > limit) gaps.set(active, 'LCOV refers to a line outside the inspected source');
      else if (file && (!codeLines || codeLines.get(active)?.has(number))) addHits(file, number, hits, index + 1);
    } else if (line.startsWith('BRDA:') || line.startsWith('FN:') || line.startsWith('FNDA:')) {
      if (active === undefined) throw new Error(`LCOV data outside a source record at line ${index + 1}`);
      if (ignored || !files.has(active)) continue;
      readDetails(active, line, index + 1);
    } else if (line === 'end_of_record') {
      if (active === undefined) throw new Error(`Unexpected LCOV record end at line ${index + 1}`);
      active = undefined;
    }
  }
  if (active !== undefined) throw new Error('Unterminated LCOV source record');
  if (!sawSource && text.trim() !== '') throw new Error('LCOV contains no source records');
  // The declaration map can now hold the hit totals. Keep the declared lines for the gutter.
  const functionCalls = new Map<string, readonly FunctionCallCount[]>();
  for (const [path, declarations] of functions) {
    const hits = called.get(path);
    const counts: FunctionCallCount[] = [];
    for (const [key, first] of declarations) {
      const count = hits?.get(key);
      declarations.set(key, count ?? 0);
      if (count !== undefined && first <= sourceLines.get(path)!) counts.push([first, count]);
    }
    if (counts.length) functionCalls.set(path, counts.sort(([left], [right]) => left - right));
  }
  return { files, branches, functions, functionCalls, gaps };

  function readDetails(path: string, line: string, record: number): void {
    const branch = /^BRDA:([1-9]\d*),([^,]+),([^,]+),(\d+|-)$/.exec(line);
    if (branch) {
      addHits(fileRecords(branches, path), `${branch[1]},${branch[2]},${branch[3]}`, branch[4] === '-' ? 0 : Number(branch[4]), record);
      return;
    }
    const declaration = /^FN:([1-9]\d*)(?:,[1-9]\d*)?,(.+)$/.exec(line);
    if (declaration) {
      const number = Number(declaration[1]);
      if (!Number.isSafeInteger(number)) throw new Error(`Invalid LCOV function line at line ${record}`);
      const records = fileRecords(functions, path);
      const key = occurrence(occurrences.declared, declaration[2]!);
      if (!records.has(key)) records.set(key, number);
      return;
    }
    const call = /^FNDA:(\d+),(.+)$/.exec(line);
    if (!call) throw new Error(`Invalid LCOV data at line ${record}`);
    addHits(fileRecords(called, path), occurrence(occurrences.called, call[2]!), Number(call[1]), record);
  }
}

function fileRecords<Key>(files: Map<string, Map<Key, number>>, path: string): Map<Key, number> {
  const existing = files.get(path);
  if (existing) return existing;
  const records = new Map<Key, number>();
  files.set(path, records);
  return records;

}

function addHits<Key>(hits: Map<Key, number>, key: Key, count: number, record: number): void {
  const total = (hits.get(key) ?? 0) + count;
  if (!Number.isSafeInteger(total)) throw new Error(`LCOV hit count exceeds the supported integer range at line ${record}`);
  hits.set(key, total);
}

function importCoverage(input: CoverageInput): CoverageResult {
  const { files, branches, functions, functionCalls, gaps } = mapCoverage(input);
  const lineCoverage: [string, FileLineCoverage][] = [];
  const lines = hitRows(files, gaps, lineMetrics, (path, hits) => {
    const hitLines: number[] = [], missedLines: number[] = [];
    for (const [line, hit] of hits) (hit ? hitLines : missedLines).push(line);
    const partialHits = partiallyCoveredLines(branches.get(path), input.sourceLines.get(path)!, input.codeLines?.get(path));
    const partial = mergedRanges([...partialHits.keys()]);
    const calls = functionCalls.get(path);
    const bodies = input.functionBodies?.get(path);
    if (hits.size || partial.length || calls !== undefined) {
      // A BRDA-only partial line has at least as many hits as its most frequently taken branch.
      const measured = new Map([...partialHits, ...hits]);
      lineCoverage.push([path, { covered: mergedRanges(hitLines), uncovered: mergedRanges(missedLines),
        ...(partial.length ? { partial } : {}), hits: mergedHits(measured),
        ...(calls === undefined ? {} : { functionCalls: calls }), ...(bodies === undefined ? {} : { functionBodies: bodies }) }]);
    }
    return hitLines.length;
  });
  const metrics = [...lines, ...hitRows(branches, gaps, branchMetrics), ...hitRows(functions, gaps, functionMetrics)];
  return { measurements: metrics, lineCoverage: Object.fromEntries(lineCoverage),
    gaps: [...gaps].sort(([left], [right]) => comparePaths(left, right)).map(([path, reason]) => ({ path, reason })) };
}

function partiallyCoveredLines(branches: ReadonlyMap<string, number> | undefined, lastLine: number,
  codeLines?: ReadonlySet<number>): Map<number, number> {
  const taken = new Map<number, number>();
  const missed = new Set<number>();
  for (const [branch, count] of branches ?? []) {
    const line = Number(branch.slice(0, branch.indexOf(',')));
    if (line > lastLine || (codeLines && !codeLines.has(line))) continue;
    if (count === 0) missed.add(line);
    else taken.set(line, Math.max(taken.get(line) ?? 0, count));
  }
  return new Map([...taken].filter(([line]) => missed.has(line)));
}

function mergedRanges(lines: number[]): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  for (const line of lines.sort((left, right) => left - right)) {
    const previous = ranges.at(-1);
    if (previous && previous[1] + 1 === line) previous[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

function mergedHits(hits: ReadonlyMap<number, number>): readonly HitRun[] {
  const runs: [number, number, number][] = [];
  for (const [line, count] of [...hits].sort(([left], [right]) => left - right)) {
    const previous = runs.at(-1);
    if (previous && previous[1] + 1 === line && previous[2] === count) previous[1] = line;
    else runs.push([line, line, count]);
  }
  return runs;
}

/** Per-file and repository ratios with their counts, for a kind the LCOV reports; nothing when it reports none. */
function hitRows<Key>(files: ReadonlyMap<string, ReadonlyMap<Key, number>>, gaps: ReadonlyMap<string, string>,
  { ids: [ratioId, coveredId, totalId], includeEmpty = false }: { ids: readonly [string, string, string]; includeEmpty?: boolean },
  coveredCount?: (path: string, hits: ReadonlyMap<Key, number>) => number): Measurement[] {
  const rows: Measurement[] = [];
  let totalCovered = 0;
  let totalCount = 0;
  for (const [path, hits] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    if (gaps.has(path) || (!hits.size && !includeEmpty)) continue;
    let covered = 0;
    if (coveredCount) covered = coveredCount(path, hits);
    else for (const hit of hits.values()) if (hit) covered++;
    totalCovered += covered;
    totalCount += hits.size;
    rows.push({ definition: ratioId, target: 'file', path, covered, total: hits.size, value: ratio(covered, hits.size) });
  }
  if (totalCount === 0 && !includeEmpty) return [];
  rows.push({ definition: ratioId, target: 'repository', covered: totalCovered, total: totalCount, value: ratio(totalCovered, totalCount) });
  return [...rows, ...rows.flatMap(({ target, path, covered, total }): Measurement[] => [
    { definition: coveredId, target, path, value: covered ?? null },
    { definition: totalId, target, path, value: total ?? null },
  ])];
}

function ratio(covered: number, total: number): number | null {
  return total === 0 ? null : covered / total;
}

function normalizeLcovPath(root: string, path: string): string {
  const platform = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? win32 : posix;
  const candidate = platform.isAbsolute(path) ? platform.relative(root, path) : path;
  if (platform.isAbsolute(candidate)) return candidate;
  return posix.normalize(platform === win32 ? candidate.replaceAll('\\', '/') : candidate);
}
