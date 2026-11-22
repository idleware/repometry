import type { QualitySummary } from '../../../core/model/quality-summary.js';
import type { MetricDescriptor } from '../../../core/model/metric-descriptor.js';
import type { SourceLocator } from '../../../core/model/source-locator.js';
import type { PublicHistoryEntry } from './public-history-model.js';
import type { ProfileBoundary } from './inspection-context-model.js';

export const summarySchema = 'urn:repometry:schema:repository-summary:1';
export type MetricValues = Readonly<Record<number, number | null>>;
export type { MetricDescriptor } from '../../../core/model/metric-descriptor.js';
export type { SourceLocator } from '../../../core/model/source-locator.js';

export interface InspectionCounts {
  readonly findingCount: number;
  readonly diagnosticCount: number;
  readonly componentCount: number;
  readonly hasCoverage: boolean;
  readonly security?: { readonly low: number; readonly medium: number; readonly high: number; readonly unknown: number };
}

export interface CommitSummary extends PublicHistoryEntry {
  readonly quality: QualitySummary;
  readonly counts?: InspectionCounts;
  readonly detail?: string;
  readonly revision?: string;
  readonly profileDigest?: string;
  readonly profileBoundary?: ProfileBoundary;
  /** Local report headers carry their own catalog. Repository summaries lift it to the document root. */
  readonly metrics?: readonly MetricDescriptor[];
  readonly values?: MetricValues;
  readonly privateMetrics?: readonly string[];
}

export interface RepositorySummary {
  readonly schema: typeof summarySchema;
  readonly commits: readonly CommitSummary[];
  readonly pullReviewCount?: number;
  readonly metrics?: readonly MetricDescriptor[];
  readonly privateMetrics?: readonly string[];
  /** Where the commits come from; the branch is the one the configuration names, never guessed. */
  readonly source?: { readonly branch?: string };
  readonly sources?: SourceLocator;
}

