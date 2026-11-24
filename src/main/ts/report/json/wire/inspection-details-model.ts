import type { Report } from '../../../core/model/report.js';
import type { FileMetricsReport } from './file-metrics-model.js';
import type { InspectionContext } from './inspection-context-model.js';
import type { ComplexFunction } from './public-history-model.js';
import type { ComponentMetrics } from './component-model.js';
import type { LineCoverage } from '../../../core/model/line-coverage.js';

export interface InspectionDetails {
  readonly metrics: FileMetricsReport;
  readonly functions: readonly ComplexFunction[];
  readonly diagnostics: Report['diagnostics'];
  readonly findings?: Report['findings'];
  readonly components?: readonly ComponentMetrics[];
  readonly lineCoverage?: LineCoverage;
  /**
   * The colour band limits the profile sets for the metrics with a meaningful scale: four ascending upper bounds
   * (three for duplication, whose first band is zero). Absent, the viewer uses its defaults.
   */
  readonly bands?: Readonly<Partial<Record<'complexity' | 'missedLines' | 'duplication', readonly number[]>>>;
  /** The profile the inspection applied, as the Profile page shows it. Local and private views only. */
  readonly profile?: ProfileSettings;
}

/** What the inspection read and how it scored it: a projection of the report's applied configuration. */
export interface ProfileSettings {
  readonly id: string | null;
  readonly languages?: readonly ProfileLanguage[];
  readonly excludedPaths: readonly string[];
  readonly excludedDirectories: readonly string[];
  /** Every check the profile applies, each named with the plugin that runs it. */
  readonly rules: readonly { readonly plugin: string; readonly rule: string; readonly limit: number; readonly minutesPerExcess: number }[];
  readonly ruleCatalog?: readonly ProfileRule[];
  readonly duplication: { readonly minCodeLines: number; readonly minNodes: number; readonly minutesPerRepeatedLine: number } | null;
  readonly debtModel: { readonly name: string; readonly scale: number; readonly exponent: number; readonly minutesPerPersonMonth: number } | null;
  readonly churn: { readonly lookbackDays: number; readonly maxCommits: number } | null;
  readonly ignore: readonly { readonly tool?: string; readonly rule?: string; readonly path?: string; readonly reason?: string }[];
  readonly analyzers: readonly { readonly id: string; readonly version: string; readonly tools: Readonly<Record<string, string>> }[];
}

export interface ProfileLanguage {
  readonly plugin: string;
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly globs: readonly string[];
}

export interface ProfileRule {
  readonly source: string;
  readonly kind: 'check' | 'scanner';
  readonly rule: string;
  readonly title?: string;
  readonly category: string;
  readonly limit?: number;
  readonly minutesPerExcess?: number;
  readonly level?: string;
  readonly help?: string;
}

export interface InspectionAsset {
  readonly schema: 'urn:repometry:schema:viewer-inspection:1';
  readonly sha: string;
  readonly context?: InspectionContext;
  readonly inspection: InspectionDetails;
}
