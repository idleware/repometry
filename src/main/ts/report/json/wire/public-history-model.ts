import type { Report } from '../../../core/model/report.js';
import type { QualitySummary } from '../../../core/model/quality-summary.js';

export const historySchema = 'urn:repometry:schema:public-history:1';

export interface PublicHistoryEntry {
  readonly sha: string;
  readonly generatedAt: string;
  /** Committer time of the inspected commit; absent when the inspection did not read Git history. */
  readonly committedAt?: string;
  /** First line of the commit message; absent in exports made before commit metadata was recorded. */
  readonly subject?: string;
  readonly author?: { readonly name: string; readonly email?: string };
  /** Names of the tags pointing at the commit. */
  readonly tags?: readonly string[];
  readonly status: Report['status'];
  readonly files: number;
  readonly parsed: number;
  readonly lines: number | null;
  readonly functions: number | null;
  readonly maxComplexity: number | null;
  readonly lineCoverage: { readonly covered: number; readonly total: number } | null;
}

export function compareHistoryEntries(a: PublicHistoryEntry, b: PublicHistoryEntry): number {
  return Number(b.committedAt !== undefined) - Number(a.committedAt !== undefined)
    || (b.committedAt ?? b.generatedAt).localeCompare(a.committedAt ?? a.generatedAt)
    || a.sha.localeCompare(b.sha);
}

export interface PublicHistory {
  readonly schema: typeof historySchema;
  readonly reports: readonly PublicHistoryEntry[];
}

export interface QualityHistory {
  readonly schema: 'urn:repometry:schema:quality-history:1';
  readonly reports: Record<string, QualitySummary>;
}

export interface ComplexFunction {
  readonly name: string;
  readonly path: string;
  readonly line: number | null;
  readonly complexity: number;
}
