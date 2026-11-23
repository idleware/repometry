import { posix, win32 } from 'node:path';
import reportSchema from '../../../resources/report/json/report-v2.schema.json' with { type: 'json' };
import { isRecord, pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, Plugin } from '../../core/engine/plugin.js';
import { comparePaths } from '../../core/model/snapshot.js';
import { definitions, measurements } from '../../core/model/measurement.js';
import type { Measurement } from '../../core/model/measurement.js';
import { lcovLines } from '../../core/model/line-coverage.js';
import type { FileLineCoverage, LineCoverage } from '../../core/model/line-coverage.js';

export interface CoverageInput {
  readonly text: string;
  readonly root: string;
  readonly sourceLines: ReadonlyMap<string, number>;
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
    && (value.excludes === undefined || typeof value.excludes === 'function'),
};

export const coverageResult: DataContract<CoverageResult> = {
  id: 'repometry.coverage-result/v1',
  accepts: (value): value is CoverageResult => isRecord(value) && measurements.accepts(value.measurements)
    && Array.isArray(value.gaps) && value.gaps.every(gap => isRecord(gap) && typeof gap.path === 'string' && typeof gap.reason === 'string')
    && lcovLines.accepts(value.lineCoverage),
};

export const coverage: Plugin = {
  id: 'lcov',
  version: '1.2.0',
  api: pluginApi,
  kinds: ['coverage', 'import'],
  produces: [{ contract: coverageResult.id, persistence: 'report', metrics: [
    { id: definitions.coverage, label: 'Line coverage', unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
      ratio: { of: definitions.coveredLines, over: definitions.coverableLines }, bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage' },
    { id: definitions.coveredLines, label: 'Covered lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
    { id: definitions.coverableLines, label: 'Measured lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
    { id: definitions.branchCoverage, label: 'Branch coverage', unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
      ratio: { of: definitions.coveredBranches, over: definitions.coverableBranches }, bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage' },
    { id: definitions.coveredBranches, label: 'Covered branches', unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
    { id: definitions.coverableBranches, label: 'Measured branches', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
    { id: definitions.functionCoverage, label: 'Function coverage', unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
      ratio: { of: definitions.coveredFunctions, over: definitions.coverableFunctions }, bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage' },
    { id: definitions.coveredFunctions, label: 'Covered functions', unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
    { id: definitions.coverableFunctions, label: 'Measured functions', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
  ] }, { contract: lcovLines.id, persistence: 'report',
    schema: { ...reportSchema.$defs.lcovLines, $defs: { lcovLineRanges: reportSchema.$defs.lcovLineRanges } } }],
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

export function mapCoverage({ text, root, sourceLines, excludes }: CoverageInput) {
  const files = new Map<string, Map<number, boolean>>();
  // Branches by line, block and branch. Functions by name and its occurrence in the record: tools such as c8 repeat a
  // name for different functions and list FNDA in FN order. Several reports merge by any hit.
  const branches = new Map<string, Map<string, boolean>>();
  const declared = new Map<string, Set<string>>();
  const called = new Map<string, Map<string, boolean>>();
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
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('SF:')) {
      if (active !== undefined || line.length === 3) throw new Error(`Unexpected LCOV source at line ${index + 1}`);
      active = normalizeLcovPath(root, line.slice(3));
      occurrences.declared.clear();
      occurrences.called.clear();
      sawSource = true;
      ignored = excludes?.(active) ?? false;
      if (ignored) continue;
      if (!sourceLines.has(active)) gaps.set(active, 'LCOV source is outside the inspected file set');
      else if (!files.has(active)) files.set(active, new Map());
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
      else if (file) file.set(number, (file.get(number) ?? false) || hits > 0);
    } else if (line.startsWith('BRDA:') || line.startsWith('FN:') || line.startsWith('FNDA:')) {
      if (active === undefined) throw new Error(`LCOV data outside a source record at line ${index + 1}`);
      if (ignored || !files.has(active)) continue;
      const branch = /^BRDA:([1-9]\d*),([^,]+),([^,]+),(\d+|-)$/.exec(line);
      const declaration = /^FN:[1-9]\d*(?:,[1-9]\d*)?,(.+)$/.exec(line);
      const call = /^FNDA:(\d+),(.+)$/.exec(line);
      if (branch) {
        const taken = branch[4] !== '-' && Number(branch[4]) > 0;
        const key = `${branch[1]},${branch[2]},${branch[3]}`;
        const file = branches.get(active) ?? new Map<string, boolean>();
        file.set(key, (file.get(key) ?? false) || taken);
        branches.set(active, file);
      } else if (declaration) {
        declared.set(active, (declared.get(active) ?? new Set<string>()).add(occurrence(occurrences.declared, declaration[1]!)));
      } else if (call) {
        const key = occurrence(occurrences.called, call[2]!);
        const file = called.get(active) ?? new Map<string, boolean>();
        file.set(key, (file.get(key) ?? false) || Number(call[1]) > 0);
        called.set(active, file);
      } else {
        throw new Error(`Invalid LCOV data at line ${index + 1}`);
      }
    } else if (line === 'end_of_record') {
      if (active === undefined) throw new Error(`Unexpected LCOV record end at line ${index + 1}`);
      active = undefined;
    }
  }
  if (active !== undefined) throw new Error('Unterminated LCOV source record');
  if (!sawSource && text.trim() !== '') throw new Error('LCOV contains no source records');
  const functions = new Map([...declared].map(([path, names]) =>
    [path, new Map([...names].map(name => [name, called.get(path)?.get(name) ?? false]))] as const));
  return { files, branches, functions, gaps };
}

function importCoverage(input: CoverageInput): CoverageResult {
  const { files, branches, functions, gaps } = mapCoverage(input);
  const rows: Measurement[] = [];
  const lineCoverage: [string, FileLineCoverage][] = [];
  let totalCovered = 0;
  let totalLines = 0;
  for (const [path, hits] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    if (gaps.has(path)) continue;
    const hitLines: number[] = [], missedLines: number[] = [];
    for (const [line, hit] of hits) (hit ? hitLines : missedLines).push(line);
    const partial = mergedRanges(partiallyCoveredLines(branches.get(path), input.sourceLines.get(path)!));
    if (hits.size || partial.length) lineCoverage.push([path, {
      covered: mergedRanges(hitLines), uncovered: mergedRanges(missedLines), ...(partial.length ? { partial } : {}),
    }]);
    const covered = hitLines.length;
    totalCovered += covered;
    totalLines += hits.size;
    rows.push({ definition: definitions.coverage, target: 'file', path, covered, total: hits.size, value: ratio(covered, hits.size) });
  }
  rows.push({ definition: definitions.coverage, target: 'repository', covered: totalCovered, total: totalLines, value: ratio(totalCovered, totalLines) });
  const counts = rows.flatMap(({ target, path, covered, total }): Measurement[] => [
    { definition: definitions.coveredLines, target, path, value: covered ?? null },
    { definition: definitions.coverableLines, target, path, value: total ?? null },
  ]);
  const extra = [
    ...hitRows(branches, gaps, definitions.branchCoverage, definitions.coveredBranches, definitions.coverableBranches),
    ...hitRows(functions, gaps, definitions.functionCoverage, definitions.coveredFunctions, definitions.coverableFunctions),
  ];
  return { measurements: [...rows, ...counts, ...extra], lineCoverage: Object.fromEntries(lineCoverage),
    gaps: [...gaps].sort(([left], [right]) => comparePaths(left, right)).map(([path, reason]) => ({ path, reason })) };
}

function partiallyCoveredLines(branches: ReadonlyMap<string, boolean> | undefined, lastLine: number): number[] {
  const taken = new Set<number>(), missed = new Set<number>();
  for (const [branch, hit] of branches ?? []) {
    const line = Number(branch.slice(0, branch.indexOf(',')));
    if (line <= lastLine) (hit ? taken : missed).add(line);
  }
  return [...taken].filter(line => missed.has(line));
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

/** Per-file and repository ratios with their counts, for a kind the LCOV reports; nothing when it reports none. */
function hitRows(files: ReadonlyMap<string, ReadonlyMap<string, boolean>>, gaps: ReadonlyMap<string, string>,
  ratioId: string, coveredId: string, totalId: string): Measurement[] {
  const rows: Measurement[] = [];
  let totalCovered = 0;
  let totalCount = 0;
  for (const [path, hits] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    if (gaps.has(path) || hits.size === 0) continue;
    let covered = 0;
    for (const hit of hits.values()) if (hit) covered++;
    totalCovered += covered;
    totalCount += hits.size;
    rows.push({ definition: ratioId, target: 'file', path, covered, total: hits.size, value: ratio(covered, hits.size) });
  }
  if (totalCount === 0) return [];
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
  if (platform === win32) return posix.normalize(candidate.replaceAll('\\', '/'));
  return posix.normalize(candidate);
}
