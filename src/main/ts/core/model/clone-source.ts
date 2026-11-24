import { isRecord } from './plugin-data.js';

export interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine: number;
  readonly codeLines: number;
  readonly nodes: number;
  readonly exact: string;
  readonly similar: string;
}

export interface CloneSource {
  readonly path: string;
  readonly scheme?: string;
  readonly codeLines: readonly number[];
  readonly candidates: readonly Candidate[];
}

function isCandidate(value: unknown): value is Candidate {
  return isRecord(value) && isCount(value.start) && isCount(value.end) && value.start < value.end
    && isCount(value.line) && value.line > 0 && isCount(value.endLine) && value.endLine >= value.line
    && isCount(value.codeLines) && isCount(value.nodes) && typeof value.exact === 'string' && typeof value.similar === 'string';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isCloneSource(value: unknown): value is CloneSource {
  return isRecord(value) && typeof value.path === 'string' && Array.isArray(value.codeLines)
    && (value.scheme === undefined || typeof value.scheme === 'string' && value.scheme.length > 0)
    && value.codeLines.every((line: unknown, index, lines) => isCount(line) && line > (lines[index - 1] ?? 0))
    && Array.isArray(value.candidates) && value.candidates.every(isCandidate);
}
