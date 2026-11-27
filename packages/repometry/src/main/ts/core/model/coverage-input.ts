import type { DataContract } from '../engine/plugin.js';
import { isRecord } from './plugin-data.js';
import type { SourceLineRange } from './source.js';

export interface CoverageInput {
  readonly text: string;
  readonly root: string;
  readonly sourceLines: ReadonlyMap<string, number>;
  readonly codeLines?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly unclassified?: ReadonlySet<string>;
  readonly functionBodies?: ReadonlyMap<string, readonly SourceLineRange[]>;
  readonly excludes?: (path: string) => boolean;
}

export const lcovInput: DataContract<CoverageInput> = {
  id: 'repometry.lcov-input/v1',
  accepts: (value): value is CoverageInput => isRecord(value) && typeof value.text === 'string'
    && typeof value.root === 'string' && value.sourceLines instanceof Map
    && (value.codeLines === undefined || value.codeLines instanceof Map)
    && (value.unclassified === undefined || value.unclassified instanceof Set)
    && (value.functionBodies === undefined || value.functionBodies instanceof Map)
    && (value.excludes === undefined || typeof value.excludes === 'function'),
};
