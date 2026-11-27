import type { FindingIgnoreRule } from '@repometry/core/internal/model/ignore-rule.js';

export type ProfileBoundary = 'changed' | 'unavailable';

export interface SourceExclusions {
  readonly paths: readonly string[];
  readonly directories: readonly string[];
}

export interface InspectionContext {
  readonly exclusions: SourceExclusions | null;
  readonly boundary: ProfileBoundary | null;
  /** Sensitive findings by severity; critical appears once the scanners' severity scores are read for it. */
  readonly security?: { readonly critical?: number; readonly low: number; readonly medium: number; readonly high: number; readonly unknown: number };
  readonly scanners?: readonly { readonly name: string; readonly version: string | null }[];
  readonly ignores?: { readonly rules: readonly FindingIgnoreRule[]; readonly count: number };
}
