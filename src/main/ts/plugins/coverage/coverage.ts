import { posix, win32 } from 'node:path';
import { isRecord, pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, Plugin } from '../../core/engine/plugin.js';
import { comparePaths } from '../../core/model/snapshot.js';
import { definitions, measurements } from '../../core/model/measurement.js';
import type { Measurement } from '../../core/model/measurement.js';

export interface CoverageInput {
  readonly text: string;
  readonly root: string;
  readonly sourceLines: ReadonlyMap<string, number>;
  readonly excludes?: (path: string) => boolean;
}

interface CoverageResult {
  readonly measurements: readonly Measurement[];
  readonly gaps: readonly { readonly path: string; readonly reason: string }[];
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
    && Array.isArray(value.gaps) && value.gaps.every(gap => isRecord(gap) && typeof gap.path === 'string' && typeof gap.reason === 'string'),
};

export const coverage: Plugin = {
  id: 'lcov',
  version: '1.1.0',
  api: pluginApi,
  kinds: ['coverage', 'import'],
  produces: [{ contract: coverageResult.id, persistence: 'report', metrics: [
    { id: definitions.coverage, label: 'Line coverage', unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
      ratio: { of: definitions.coveredLines, over: definitions.coverableLines }, bands: [0.6, 0.7, 0.8, 0.9], group: 'Coverage' },
    { id: definitions.coveredLines, label: 'Covered lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
    { id: definitions.coverableLines, label: 'Measured lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
  ] }],
  operations: [{
    id: 'import',
    role: 'inspection',
    inputs: { report: lcovInput },
    output: coverageResult,
    execute: inputs => importCoverage(inputs.read('report', lcovInput)),
  }],
};

export function mapCoverage({ text, root, sourceLines, excludes }: CoverageInput) {
  const files = new Map<string, Map<number, boolean>>();
  const gaps = new Map<string, string>();
  let active: string | undefined;
  let ignored = false;
  let sawSource = false;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('SF:')) {
      if (active !== undefined || line.length === 3) throw new Error(`Unexpected LCOV source at line ${index + 1}`);
      active = normalizeLcovPath(root, line.slice(3));
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
    } else if (line === 'end_of_record') {
      if (active === undefined) throw new Error(`Unexpected LCOV record end at line ${index + 1}`);
      active = undefined;
    }
  }
  if (active !== undefined) throw new Error('Unterminated LCOV source record');
  if (!sawSource && text.trim() !== '') throw new Error('LCOV contains no source records');
  return { files, gaps };
}

function importCoverage(input: CoverageInput): CoverageResult {
  const { files, gaps } = mapCoverage(input);
  const rows: Measurement[] = [];
  let totalCovered = 0;
  let totalLines = 0;
  for (const [path, hits] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    if (gaps.has(path)) continue;
    let covered = 0;
    for (const hit of hits.values()) if (hit) covered++;
    totalCovered += covered;
    totalLines += hits.size;
    rows.push({ definition: definitions.coverage, target: 'file', path, covered, total: hits.size, value: ratio(covered, hits.size) });
  }
  rows.push({ definition: definitions.coverage, target: 'repository', covered: totalCovered, total: totalLines, value: ratio(totalCovered, totalLines) });
  const counts = rows.flatMap(({ target, path, covered, total }): Measurement[] => [
    { definition: definitions.coveredLines, target, path, value: covered ?? null },
    { definition: definitions.coverableLines, target, path, value: total ?? null },
  ]);
  return { measurements: [...rows, ...counts],
    gaps: [...gaps].sort(([left], [right]) => comparePaths(left, right)).map(([path, reason]) => ({ path, reason })) };
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
