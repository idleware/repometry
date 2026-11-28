import type { DataContract } from './plugin.js';
import { codeStructure as storedStructure, codeStructures as storedStructures } from '../model/code-structure.js';
import type { CodeStructure as StoredStructure, StructuralObservation as StoredObservation } from '../model/code-structure.js';
import { findingResult as storedFindings } from '../model/finding.js';
import type { Finding as StoredFinding, FindingResult as StoredFindings } from '../model/finding.js';
import { category } from '../model/inspection-category.js';
import type { PluginCategory } from '../model/inspection-category.js';
import { isRecord } from '../model/plugin-data.js';

export type StructuralObservation = Omit<StoredObservation, 'rule'> & { readonly check: StoredObservation['rule'] };
export type CodeStructure = Omit<StoredStructure, 'observations'> & { readonly observations?: readonly StructuralObservation[] };

export type Finding = Omit<StoredFinding, 'tool' | 'rule' | 'category'> & { readonly plugin?: string; readonly check: string };
export type FindingResult = Omit<StoredFindings, 'findings'> & { readonly findings: readonly Finding[] };

export const codeStructure: DataContract<CodeStructure> = { id: storedStructure.id,
  accepts: (value): value is CodeStructure => storedStructure.accepts(writeStructure(value)) };

export const codeStructures: DataContract<readonly CodeStructure[]> = { id: storedStructures.id,
  accepts: (value): value is readonly CodeStructure[] => Array.isArray(value) && value.every(codeStructure.accepts) };

export const findingResult: DataContract<FindingResult> = { id: storedFindings.id,
  accepts: (value): value is FindingResult => storedFindings.accepts(writeFindings(value)) };

export function writeStructure(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.observations)) return value;
  return { ...value, observations: value.observations.map(writeObservation) };
}

function writeObservation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { check, ...fields } = value;
  return { ...fields, rule: check };
}

export function writeFindings(value: unknown, id?: string, dimension?: PluginCategory): unknown {
  if (!isRecord(value) || !Array.isArray(value.findings)) return value;
  return { ...value, findings: value.findings.map(finding => writeFinding(finding, id, dimension)) };
}

function writeFinding(value: unknown, id: string | undefined, dimension: PluginCategory | undefined): unknown {
  if (!isRecord(value)) return value;
  const { plugin, check, ...fields } = value;
  if (id !== undefined && plugin !== undefined && plugin !== id) throw new Error('A finding may only name its reporting plugin ' + id);
  if (dimension !== undefined && dimension !== category.maintainability && dimension !== category.security) {
    throw new Error('Plugins in ' + dimension + ' do not produce findings');
  }
  const group = findingCategory(dimension, fields.effortMinutes !== undefined);
  return { ...fields, tool: plugin ?? id ?? 'plugin', rule: check, category: group };
}

export function readStructure(value: StoredStructure): CodeStructure {
  const { observations, ...fields } = value;
  return observations === undefined ? fields : { ...value, observations: observations.map(({ rule, ...entry }) => ({ ...entry, check: rule })) };
}

export function readFindings(value: StoredFindings): FindingResult {
  return { ...value, findings: value.findings.map(({ tool, rule, category, ...entry }) => ({ ...entry, plugin: tool, check: rule })) };
}

export function findingCategory(dimension: PluginCategory | undefined, chargesEffort: boolean): StoredFinding['category'] {
  if (dimension === category.security) return 'security';
  return chargesEffort ? 'structure' : 'lint';
}
