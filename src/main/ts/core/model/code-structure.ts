import { isRecord } from '../engine/plugin.js';
import type { DataContract } from '../engine/plugin.js';
import { isCloneSource } from './clone-source.js';
import type { CloneSource } from './clone-source.js';

export const structuralCheckIds = [
  'function-parameters', 'return-statements', 'boolean-logic', 'nested-control-flow',
  'function-complexity', 'file-complexity',
] as const;

export type StructuralCheck = typeof structuralCheckIds[number];

export interface FunctionComplexity {
  readonly name: string;
  readonly line?: number;
  readonly column?: number;
  readonly value: number;
}

export interface StructuralObservation {
  readonly rule: StructuralCheck;
  readonly value: number;
  readonly label: string;
  readonly line?: number;
  readonly endLine?: number;
}

export interface CodeStructure {
  readonly path: string;
  readonly lines: number;
  readonly functions: number;
  readonly classes: number;
  readonly cognitiveComplexity: number;
  readonly commentLines: number;
  readonly cyclomaticFunctions: readonly FunctionComplexity[];
  readonly cognitiveFunctions: readonly FunctionComplexity[];
  readonly observations: readonly StructuralObservation[];
  readonly clones: CloneSource;
}

const checkIds = new Set<string>(structuralCheckIds);

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPosition(value: unknown): value is number | undefined {
  return value === undefined || (isCount(value) && value > 0);
}

function isFunctionComplexity(value: unknown): value is FunctionComplexity {
  return isRecord(value) && typeof value.name === 'string' && isCount(value.value)
    && isPosition(value.line) && isPosition(value.column);
}

function isObservation(value: unknown): value is StructuralObservation {
  return isRecord(value) && typeof value.rule === 'string' && checkIds.has(value.rule)
    && typeof value.label === 'string' && isCount(value.value) && isPosition(value.line) && isPosition(value.endLine);
}

export const codeStructure: DataContract<CodeStructure> = {
  id: 'repometry.code-structure/v1',
  accepts: (value): value is CodeStructure => isRecord(value)
    && typeof value.path === 'string' && isCount(value.lines) && isCount(value.functions) && isCount(value.classes)
    && isCount(value.cognitiveComplexity) && isCount(value.commentLines)
    && Array.isArray(value.cyclomaticFunctions) && value.cyclomaticFunctions.every(isFunctionComplexity)
    && Array.isArray(value.cognitiveFunctions) && value.cognitiveFunctions.every(isFunctionComplexity)
    && Array.isArray(value.observations) && value.observations.every(isObservation)
    && isCloneSource(value.clones) && value.clones.path === value.path,
};
