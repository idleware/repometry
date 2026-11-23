import { isRecord } from '../engine/plugin.js';
import type { DataContract } from '../engine/plugin.js';

export const definitions = {
  lines: 'repometry.physical-lines/v1',
  functions: 'repometry.functions/v1',
  complexity: 'repometry.cyclomatic-babel/v1',
  coverage: 'repometry.lcov-line-coverage/v1',
  coveredLines: 'repometry.lcov-covered-lines/v1',
  coverableLines: 'repometry.lcov-coverable-lines/v1',
  branchCoverage: 'repometry.lcov-branch-coverage/v1',
  coveredBranches: 'repometry.lcov-covered-branches/v1',
  coverableBranches: 'repometry.lcov-coverable-branches/v1',
  functionCoverage: 'repometry.lcov-function-coverage/v1',
  coveredFunctions: 'repometry.lcov-covered-functions/v1',
  coverableFunctions: 'repometry.lcov-coverable-functions/v1',
  codeLines: 'repometry.code-lines-babel/v1',
  comments: 'repometry.comment-lines-babel/v1',
  classes: 'repometry.classes-babel/v1',
  cognitiveComplexity: 'repometry.cognitive-babel/v1',
  duplicatedLines: 'repometry.duplicated-lines-babel/v1',
  churn: 'repometry.git-change-frequency/v1',
} as const;

export interface Measurement {
  readonly definition: string;
  readonly target: 'repository' | 'file' | 'function';
  readonly value: number | null;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly name?: string;
  readonly covered?: number;
  readonly total?: number;
}

function isMeasurement(value: unknown): value is Measurement {
  return isRecord(value) && typeof value.definition === 'string'
    && (value.target === 'repository' || value.target === 'file' || value.target === 'function')
    && (value.value === null || (typeof value.value === 'number' && Number.isFinite(value.value)));
}

export const measurements: DataContract<readonly Measurement[]> = {
  id: 'repometry.measurements/v1',
  accepts: (value): value is readonly Measurement[] => Array.isArray(value) && value.every(isMeasurement),
};
