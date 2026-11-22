import { isRecord, pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, Plugin } from '../../core/engine/plugin.js';
import type { GitChanges, LineRange } from '../../core/model/changes.js';
import { comparePaths } from '../../core/model/snapshot.js';
import { lcovInput, mapCoverage } from './coverage.js';
import type { CoverageInput } from './coverage.js';

import type { DiffCoverage, DiffCoverageResult, FileCoverage } from '../../core/model/diff-coverage.js';
export type { DiffCoverage } from '../../core/model/diff-coverage.js';

export const changesInput: DataContract<GitChanges> = {
  id: 'repometry.git-line-changes/v1',
  accepts: (value): value is GitChanges => isRecord(value) && value.files instanceof Map && value.gaps instanceof Map,
};

export const diffCoverageResult: DataContract<DiffCoverageResult> = {
  id: 'repometry.diff-coverage-result/v1',
  accepts: (value): value is DiffCoverageResult => isRecord(value) && Array.isArray(value.files) && Array.isArray(value.gaps)
    && Array.isArray(value.uncovered)
    && (value.status === 'complete' || value.status === 'partial' || value.status === 'not-applicable')
    && typeof value.covered === 'number' && typeof value.total === 'number'
    && (value.percent === null || typeof value.percent === 'number'),
};

export const diffCoverage: Plugin = {
  id: 'diff-coverage',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['coverage'],
  produces: [{ contract: diffCoverageResult.id, persistence: 'transient' }],
  operations: [{
    id: 'measure',
    role: 'inspection',
    inputs: { changes: changesInput, lcov: lcovInput },
    output: diffCoverageResult,
    execute: inputs => measure(inputs.read('changes', changesInput), inputs.read('lcov', lcovInput)),
  }],
};

function measure(changes: GitChanges, input: CoverageInput): DiffCoverageResult {
  if (changes.files.size === 0 && changes.gaps.size === 0) {
    return { status: 'not-applicable', covered: 0, total: 0, percent: null, files: [], gaps: [], uncovered: [] };
  }
  const lcov = mapCoverage(input);
  const gaps = new Map([...lcov.gaps, ...changes.gaps]);
  const files: FileCoverage[] = [];
  const uncovered: DiffCoverageResult['uncovered'][number][] = [];
  let covered = 0;
  let total = 0;
  for (const [path, ranges] of changes.files) {
    const addedLines = ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0);
    const lines = lcov.files.get(path);
    if (gaps.has(path) || lines === undefined) {
      if (!gaps.has(path)) gaps.set(path, 'Changed file has no LCOV source record');
      files.push({ path, addedLines, covered: null, total: null });
      continue;
    }
    let fileCovered = 0;
    let fileTotal = 0;
    const missed: number[] = [];
    for (const [line, hit] of lines) {
      if (!containsLine(ranges, line)) continue;
      fileTotal++;
      if (hit) fileCovered++;
      else missed.push(line);
    }
    covered += fileCovered;
    total += fileTotal;
    files.push({ path, addedLines, covered: fileCovered, total: fileTotal });
    if (missed.length > 0) uncovered.push({ path, lines: missed.sort((left, right) => left - right) });
  }
  return {
    status: gaps.size > 0 ? 'partial' : total === 0 ? 'not-applicable' : 'complete',
    covered, total, percent: total === 0 ? null : 100 * covered / total,
    files: files.sort((a, b) => comparePaths(a.path, b.path)),
    gaps: [...gaps].sort(([a], [b]) => comparePaths(a, b)).map(([path, reason]) => ({ path, reason })),
    uncovered: uncovered.sort((left, right) => comparePaths(left.path, right.path)),
  };
}

function containsLine(ranges: readonly LineRange[], line: number): boolean {
  let lower = 0;
  let upper = ranges.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const { first, last } = ranges[middle]!;
    if (line < first) upper = middle;
    else if (line > last) lower = middle + 1;
    else return true;
  }
  return false;
}
