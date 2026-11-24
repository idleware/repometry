import type { Report } from '../../../core/model/report.js';
import type { ChurnWindow } from '../../../core/model/churn.js';
import type { MetricDescriptor, MetricValues } from './summary-model.js';

export const fileMetricsSchema = 'urn:repometry:schema:file-metrics:1';

export interface Complexity {
  readonly sum: number;
  readonly maximum: number | null;
  readonly measuredFunctions: number;
}

interface LineCoverage {
  readonly covered: number;
  readonly total: number;
}

interface Duplication {
  readonly duplicatedLines: number;
  readonly codeLines: number;
}

export interface Maintainability {
  readonly smells: number;
  readonly effortMinutes: number | null;
}

export interface Quality {
  codeLines?: number;
  commentLines?: number;
  classes?: number;
  cognitiveComplexity?: number;
  churn?: number;
  duplication?: Duplication;
  maintainability?: Maintainability;
}

export interface Metrics {
  readonly path: string;
  lines: number | null;
  /** Size in bytes; absent in reports made before sizes were recorded. */
  bytes?: number;
  functions: number | null;
  complexity: Complexity | null;
  lineCoverage: LineCoverage | null;
  diagnosticCount: number;
  quality?: Quality;
  values?: MetricValues;
  language?: number;
  provider?: string;
  analysed?: boolean;
}

export interface DirectoryMetrics extends Metrics {
  files: number;
  sizeMeasuredFiles: number;
  coverageMeasuredFiles: number;
}

export interface FileMetricsReport {
  readonly schema: typeof fileMetricsSchema;
  readonly subject: Report['subject'];
  readonly generatedAt: string;
  readonly status: Report['status'];
  readonly scope: Report['scope'];
  readonly files: readonly Metrics[];
  readonly directories: readonly DirectoryMetrics[];
  readonly unassignedDiagnostics: number;
  readonly catalog?: readonly MetricDescriptor[];
  readonly languages?: readonly { readonly id: string; readonly label?: string; readonly color?: string; readonly analysed: boolean }[];
  readonly churnWindow?: ChurnWindow & { readonly lookbackDays: number; readonly maxCommits: number };
  readonly hotspots: {
    readonly complexity: readonly string[];
    readonly missedLines: readonly string[];
    readonly cognitive?: readonly string[];
    readonly duplication?: readonly string[];
    readonly churn?: readonly string[];
  };
}
