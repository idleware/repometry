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
  return isRecord(value) && typeof value.tool === 'string' && value.tool.length > 0
    && typeof value.rule === 'string' && value.rule.length > 0 && typeof value.message === 'string' && value.message.length > 0
    && findingCategories.some(category => category === value.category) && findingLevels.some(level => level === value.level)
    && (value.path === undefined || (typeof value.path === 'string' && value.path.length > 0))
    && (value.line === undefined || (value.path !== undefined && count(value.line, 1)))
    && (value.endLine === undefined || (typeof value.line === 'number' && count(value.endLine, value.line)))
    && (value.effortMinutes === undefined || count(value.effortMinutes, 0))
    && (value.related === undefined || (Array.isArray(value.related) && value.related.every(isLocation)));
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
