import type { Report } from './report.js';

export const comparisonSchema = 'urn:repometry:schema:comparison:1';

export interface Observation {
  readonly status: 'complete' | 'partial' | 'not-applicable' | 'unavailable';
  readonly value: number | null;
  readonly covered?: number;
  readonly total?: number;
}

export interface MetricComparison {
  readonly definition: string;
  readonly unit: 'count' | 'percent';
  readonly baseline: Observation;
  readonly current: Observation;
  readonly status: 'comparable' | 'incompatible' | 'unavailable';
  readonly reason: 'observations-unavailable' | 'source-scope-unknown' | 'source-scope-changed' | 'method-unknown' | 'method-changed' | null;
  readonly delta: number | null;
}

export type ComparisonSubject = Pick<Report, 'subject' | 'generatedAt' | 'status' | 'scope'>;

export interface InspectionComparison {
  readonly schema: typeof comparisonSchema;
  readonly baseline: ComparisonSubject;
  readonly current: ComparisonSubject;
  readonly metrics: Readonly<Record<'physicalLines' | 'functions' | 'maxCyclomaticComplexity' | 'lineCoverage', MetricComparison>>;
}
