import { isRecord } from '../engine/plugin.js';
import type { Report } from './report.js';
import { definitions } from './measurement.js';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface QualitySummary {
  readonly codeLines: number | null;
  readonly comments: number | null;
  readonly classes: number | null;
  readonly cognitiveComplexity: number | null;
  readonly duplication: { readonly duplicatedLines: number; readonly codeLines: number; readonly ratio: number | null } | null;
  readonly maintainability: {
    readonly smells: number;
    readonly effortMinutes: number;
    readonly debtRatio: number | null;
    readonly grade: Grade | null;
  } | null;
}

interface DebtModel {
  readonly name: 'basic-cocomo-organic';
  readonly scale: number;
  readonly exponent: number;
  readonly minutesPerPersonMonth: number;
}

export const debtModel: DebtModel = { name: 'basic-cocomo-organic', scale: 2.4, exponent: 1.05, minutesPerPersonMonth: 9600 };

export function qualitySummary(report: Report): QualitySummary {
  const totals = new Map<string, number>();
  let codeMeasuredFiles = 0;
  let duplicationMeasuredFiles = 0;
  for (const item of report.measurements) {
    if (item.target !== 'file' || item.value === null || !Number.isSafeInteger(item.value) || item.value < 0) continue;
    if (item.definition === definitions.codeLines) codeMeasuredFiles++;
    if (item.definition === definitions.duplicatedLines) duplicationMeasuredFiles++;
    totals.set(item.definition, (totals.get(item.definition) ?? 0) + item.value);
  }
  const codeLines = totals.get(definitions.codeLines) ?? null;
  const duplicatedLines = totals.get(definitions.duplicatedLines) ?? null;
  const smells = report.findings?.filter(finding => finding.category === 'duplication' || finding.category === 'structure');
  const effortMinutes = smells?.reduce((sum, finding) => sum + (finding.effortMinutes ?? 0), 0) ?? 0;
  const hasCompleteData = codeMeasuredFiles === report.scope.files && duplicationMeasuredFiles === report.scope.files;
  const savedConfig = report.appliedConfig.maintainability;
  const model = isRecord(savedConfig) ? readDebtModel(savedConfig.debtModel) : null;
  const debtRatio = !hasCompleteData || codeLines === null || model === null || smells?.some(finding => finding.effortMinutes === undefined)
    ? null : technicalDebtRatio(effortMinutes, codeLines, model);
  return {
    codeLines,
    comments: totals.get(definitions.comments) ?? null,
    classes: totals.get(definitions.classes) ?? null,
    cognitiveComplexity: totals.get(definitions.cognitiveComplexity) ?? null,
    duplication: duplicatedLines === null || codeLines === null || codeMeasuredFiles !== duplicationMeasuredFiles
      ? null : { duplicatedLines, codeLines, ratio: codeLines === 0 || duplicatedLines > codeLines ? null : duplicatedLines / codeLines },
    maintainability: smells === undefined || codeLines === null ? null : { smells: smells.length, effortMinutes, debtRatio,
      grade: debtRatio === null ? null : maintainabilityGrade(debtRatio) },
  };
}

export function technicalDebtRatio(effortMinutes: number, codeLines: number, model = debtModel): number | null {
  if (codeLines <= 0) return null;
  const ratio = effortMinutes / (model.scale * (codeLines / 1000) ** model.exponent * model.minutesPerPersonMonth);
  return Number.isFinite(ratio) ? ratio : null;
}

export function maintainabilityGrade(debtRatio: number): Grade {
  return debtRatio < 0.05 ? 'A' : debtRatio < 0.1 ? 'B' : debtRatio < 0.2 ? 'C' : debtRatio < 0.5 ? 'D' : 'F';
}

export function coverageGrade(ratio: number): Grade {
  return ratio >= 0.9 ? 'A' : ratio >= 0.8 ? 'B' : ratio >= 0.7 ? 'C' : ratio >= 0.6 ? 'D' : 'F';
}

/**
 * Security as a grade, not a risk level: A with no findings, then B, C, D and F by the worst severity found
 * (low or unclassified, medium, high, critical). A high risk is a low grade.
 */
export function securityGrade(counts: { readonly critical?: number; readonly high: number; readonly medium: number;
  readonly low: number; readonly unknown: number }): Grade {
  return counts.critical ? 'F' : counts.high ? 'D' : counts.medium ? 'C' : counts.low || counts.unknown ? 'B' : 'A';
}

function readDebtModel(model: unknown): DebtModel | null {
  if (!isRecord(model) || model.name !== 'basic-cocomo-organic' || !positiveNumber(model.scale)
    || !positiveNumber(model.exponent) || !positiveNumber(model.minutesPerPersonMonth)) return null;
  return { name: model.name, scale: model.scale, exponent: model.exponent, minutesPerPersonMonth: model.minutesPerPersonMonth };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
