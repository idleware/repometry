import type { category } from './inspection-category.js';
import type { Finding } from './finding.js';

export type InspectionIgnoreCategory = typeof category.maintainability | typeof category.security | typeof category.coverage;

export interface FindingIgnoreRule {
  readonly category?: InspectionIgnoreCategory;
  readonly plugin?: string;
  readonly check?: string;
  readonly path?: string | readonly string[];
  readonly reason: string;
}

/** Shape used in saved reports, including reports written before inspection categories. */
export interface RecordedFindingIgnore {
  readonly category?: InspectionIgnoreCategory;
  readonly tool?: string;
  readonly rule?: string;
  readonly path?: string | readonly string[];
  readonly reason?: string;
}

export interface IgnoredFinding {
  readonly finding: Finding;
  readonly matchedRule: number;
}
