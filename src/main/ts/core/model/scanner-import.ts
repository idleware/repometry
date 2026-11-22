import { isRecord } from '../engine/plugin.js';
import { findingCategories } from './finding.js';
import type { Finding } from './finding.js';

export type FindingInput = {
  readonly file: string;
  readonly toolVersion?: string;
  readonly settingsDigest?: string;
  readonly scope?: string;
} & (
  { readonly format: 'sarif'; readonly category: 'lint' | 'security' | 'secret' }
  | { readonly format: 'eslint'; readonly category: 'lint' }
  | { readonly format: 'osv'; readonly category: 'dependency' }
);

export interface Scanner {
  readonly name: string;
  readonly version: string | null;
}

interface ImportMethod {
  readonly format: FindingInput['format'];
  readonly category: Finding['category'];
  readonly tools: readonly Scanner[];
  readonly settingsDigest: string | null;
  readonly scope: string | null;
}

export interface ImportMetadata extends ImportMethod {
  readonly inputDigest: string;
  readonly reported: number;
  readonly imported: number;
  readonly unmapped: number;
  readonly units: number;
}

/** Keep scanner identity in profile comparisons while dropping the per-snapshot inputs and counts. */
export function findingImportMethods(value: unknown): readonly ImportMethod[] {
  if (!Array.isArray(value)) return [];
  const methods = new Map<string, ImportMethod>();
  for (const item of value) {
    if (!isRecord(item) || (item.format !== 'sarif' && item.format !== 'eslint' && item.format !== 'osv')) continue;
    const category = findingCategories.find(candidate => candidate === item.category);
    if (!category || !Array.isArray(item.tools)) continue;
    const tools = item.tools.filter((tool): tool is Scanner => isRecord(tool) && typeof tool.name === 'string'
      && (tool.version === null || typeof tool.version === 'string'));
    const method: ImportMethod = { category, format: item.format, tools: uniqueScanners(tools),
      settingsDigest: scannerText(item.settingsDigest) ?? null, scope: scannerText(item.scope) ?? null };
    methods.set(JSON.stringify(method), method);
  }
  return [...methods].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

export function uniqueScanners(tools: readonly Scanner[]): Scanner[] {
  return [...new Map(tools.map(({ name, version }) => [JSON.stringify([name, version]), { name, version }] as const))]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, tool]) => tool);
}

export function scannerText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
