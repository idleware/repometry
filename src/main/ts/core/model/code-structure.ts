import { isRecord } from './plugin-data.js';
import type { DataContract } from '../engine/plugin.js';
import { isCloneSource } from './clone-source.js';
import type { CloneSource } from './clone-source.js';
import { isMergedLineRanges } from './source.js';
import type { SourceLineRange } from './source.js';

export const structuralCheckIds = [
  'function-parameters', 'return-statements', 'boolean-logic', 'nested-control-flow',
  'function-complexity', 'file-complexity',
] as const;

export type StructuralCheck = typeof structuralCheckIds[number];

export const structureMeasures = ['functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'classes',
  'commentLines', 'codeLines', 'duplication', 'structuralRules'] as const;

export type StructureMeasure = typeof structureMeasures[number];

export interface FunctionComplexity {
  /** Functions without a name omit this field. Reports display them as (anonymous). */
  readonly name?: string;
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
  readonly functions?: number;
  readonly classes?: number;
  readonly cognitiveComplexity?: number;
  readonly commentLines?: number;
  readonly cyclomaticFunctions?: readonly FunctionComplexity[];
  readonly cognitiveFunctions?: readonly FunctionComplexity[];
  /** Sorted, merged lines containing code inside a function body. An empty list means the provider found none. */
  readonly functionBodies?: readonly SourceLineRange[];
  readonly observations?: readonly StructuralObservation[];
  readonly codeLines?: readonly number[];
  readonly clones?: CloneSource;
}

const checkIds = new Set<string>(structuralCheckIds);

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPosition(value: unknown): value is number | undefined {
  return value === undefined || (isCount(value) && value > 0);
}

function isFunctionComplexity(value: unknown): value is FunctionComplexity {
  return isRecord(value) && (value.name === undefined || typeof value.name === 'string') && isCount(value.value)
    && isPosition(value.line) && isPosition(value.column);
}

function isObservation(value: unknown): value is StructuralObservation {
  return isRecord(value) && typeof value.rule === 'string' && checkIds.has(value.rule)
    && typeof value.label === 'string' && isCount(value.value) && isPosition(value.line) && isPosition(value.endLine);
}

export const codeStructure: DataContract<CodeStructure> = {
  id: 'repometry.code-structure/v1',
  accepts: (value): value is CodeStructure => isRecord(value)
    && typeof value.path === 'string' && isCount(value.lines)
    && [value.functions, value.classes, value.cognitiveComplexity, value.commentLines].every(count => count === undefined || isCount(count))
    && (value.cyclomaticFunctions === undefined || Array.isArray(value.cyclomaticFunctions) && value.cyclomaticFunctions.every(isFunctionComplexity))
    && (value.cognitiveFunctions === undefined || Array.isArray(value.cognitiveFunctions) && value.cognitiveFunctions.every(isFunctionComplexity))
    && (value.functionBodies === undefined || isMergedLineRanges(value.functionBodies) && (value.functionBodies.at(-1)?.[1] ?? 0) <= value.lines)
    && (value.observations === undefined || Array.isArray(value.observations) && value.observations.every(isObservation))
    && (value.codeLines === undefined || Array.isArray(value.codeLines) && isCodeLines(value.codeLines, value.lines))
    && (value.clones === undefined || isCloneSource(value.clones) && value.clones.path === value.path),
};

function isCodeLines(lines: readonly unknown[], lastLine: number): boolean {
  let previous = 0;
  for (const line of lines) {
    if (!isCount(line) || line <= previous || line > lastLine) return false;
    previous = line;
  }
  return true;
}

export function structureCodeLines(value: CodeStructure): readonly number[] | undefined {
  return value.codeLines ?? value.clones?.codeLines;
}

/** A repository provider returns at most one structure per input path. */
export const codeStructures: DataContract<readonly CodeStructure[]> = {
  id: 'repometry.code-structures/v1',
  accepts: (value): value is readonly CodeStructure[] => Array.isArray(value) && value.every(codeStructure.accepts)
    && new Set(value.map(({ path }) => path)).size === value.length,
};
