import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { GitChanges, LineRange } from '@repometry/core/internal/model/changes.js';
import { comparePaths } from '@repometry/core/internal/model/snapshot.js';
import { mapCoverage } from './coverage.js';
import { lcovInput } from '@repometry/core/internal/model/coverage-input.js';
import type { CoverageInput } from '@repometry/core/internal/model/coverage-input.js';

import { changesInput } from '@repometry/core/internal/model/changes.js';
import { diffCoverageResult } from '@repometry/core/internal/model/diff-coverage.js';
import type { DiffCoverage, DiffCoverageResult, FileCoverage } from '@repometry/core/internal/model/diff-coverage.js';
export type { DiffCoverage } from '@repometry/core/internal/model/diff-coverage.js';

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
