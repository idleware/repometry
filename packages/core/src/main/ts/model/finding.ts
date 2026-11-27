import { isRecord } from './plugin-data.js';
import type { DataContract } from '../engine/plugin.js';
import { measurements } from './measurement.js';
import type { Measurement } from './measurement.js';

export const findingCategories = ['structure', 'duplication', 'lint', 'security', 'dependency', 'secret', 'infrastructure'] as const;
export const findingLevels = ['low', 'medium', 'high', 'unknown'] as const;

export interface FindingLocation {
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
}

export interface Finding {
  readonly tool: string;
  readonly rule: string;
  readonly category: typeof findingCategories[number];
  readonly level: typeof findingLevels[number];
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly effortMinutes?: number;
  readonly related?: readonly FindingLocation[];
  /** The measured value the rule judged, such as a function's cognitive complexity or a duplicate's copy count. */
  readonly value?: number;
  /** The value the rule allows. */
  readonly limit?: number;
  /** What the issue is about across commits: a function's qualified name, `(file)`, or a duplicate's fingerprint. */
  readonly anchor?: string;
}

export function isSensitiveFinding(category: Finding['category']): boolean {
  return category === 'security' || category === 'dependency' || category === 'secret' || category === 'infrastructure';
}

function count(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isLocation(value: unknown): value is FindingLocation {
  return isRecord(value) && typeof value.path === 'string' && value.path.length > 0
    && count(value.line, 1) && count(value.endLine, value.line);
}

export function isFinding(value: unknown): value is Finding {
  return isRecord(value) && namesIssue(value) && placesIssue(value) && measuresIssue(value);
}

function namesIssue(value: Readonly<Record<string, unknown>>): boolean {
  return text(value.tool) && text(value.rule) && text(value.message)
    && findingCategories.some(category => category === value.category) && findingLevels.some(level => level === value.level);
}

function placesIssue(value: Readonly<Record<string, unknown>>): boolean {
  return optional(value.path, text) && optional(value.line, line => value.path !== undefined && count(line, 1))
    && optional(value.endLine, endLine => typeof value.line === 'number' && count(endLine, value.line))
    && optional(value.related, related => Array.isArray(related) && related.every(isLocation));
}

function measuresIssue(value: Readonly<Record<string, unknown>>): boolean {
  return optional(value.effortMinutes, minutes => count(minutes, 0)) && optional(value.value, measure)
    && optional(value.limit, measure) && optional(value.anchor, text);
}

function optional(value: unknown, test: (value: unknown) => boolean): boolean {
  return value === undefined || test(value);
}

function text(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function measure(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export interface FindingResult {
  readonly measurements: readonly Measurement[];
  readonly findings: readonly Finding[];
}

export const findingResult: DataContract<FindingResult> = {
  id: 'repometry.findings-and-measurements/v1',
  accepts: (value): value is FindingResult => isRecord(value) && measurements.accepts(value.measurements)
    && Array.isArray(value.findings) && value.findings.every(isFinding),
};
