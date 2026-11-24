import { isRecord } from './plugin-data.js';
import type { Report } from './report.js';
import { canonicalMetricId, definitions } from './measurement.js';

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
    readonly gradeCoverage?: { readonly measuredFiles: number; readonly totalFiles: number };
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
  const files = collectFileMeasures(report);
  const totalFiles = report.scope.files;
  const completeTotal = (id: string) => totalMeasured(files.get(id), totalFiles);
  const codeLines = completeTotal(definitions.codeLines);
  const duplicatedLines = completeTotal(definitions.duplicatedLines);
  return {
    codeLines,
    comments: completeTotal(definitions.comments),
    classes: completeTotal(definitions.classes),
    cognitiveComplexity: completeTotal(definitions.cognitiveComplexity),
    duplication: duplicatedLines === null || codeLines === null ? null
      : { duplicatedLines, codeLines, ratio: codeLines === 0 || duplicatedLines > codeLines ? null : duplicatedLines / codeLines },
    maintainability: gradeMeasuredFiles(report, files.get(definitions.codeLines), files.get(definitions.duplicatedLines)),
  };
}

function collectFileMeasures(report: Report): Map<string, Map<string, number>> {
  const files = new Map<string, Map<string, number>>();
  for (const { target, path, definition, value } of report.measurements) {
    if (target !== 'file' || path === undefined || value === null || !Number.isSafeInteger(value) || value < 0) continue;
    const id = canonicalMetricId(definition);
    let measured = files.get(id);
    if (!measured) files.set(id, measured = new Map());
    measured.set(path, (measured.get(path) ?? 0) + value);
  }
  return files;
}

function totalMeasured(values: ReadonlyMap<string, number> | undefined, expected: number): number | null {
  if (values?.size !== expected) return null;
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

function gradeMeasuredFiles(report: Report, code: ReadonlyMap<string, number> | undefined,
  duplication: ReadonlyMap<string, number> | undefined): QualitySummary['maintainability'] {
  if (report.findings === undefined || code === undefined) return null;
  const skipped = new Set(report.ruleSkips?.filter(({ plugin }) => plugin === 'maintainability' || plugin === 'duplication')
    .map(({ path }) => path));
  const measured = new Map([...code].filter(([path]) => duplication?.has(path) && !skipped.has(path)));
  const smells = report.findings.filter(finding => finding.category === 'duplication' || finding.category === 'structure');
  const totalFiles = report.scope.files;
  const complete = measured.size === totalFiles;
  const eligible = complete ? smells : smells.filter(({ path }) => path !== undefined && measured.has(path));
  const effortMinutes = eligible.reduce((sum, finding) => sum + (finding.effortMinutes ?? 0), 0);
  const config = report.appliedConfig.maintainability;
  const model = isRecord(config) ? readDebtModel(config.debtModel) : null;
  const sized = totalMeasured(measured, measured.size);
  const canGrade = complete || (report.scope.parsed === totalFiles
    && measured.size + skipped.size === totalFiles);
  const debtRatio = !canGrade || !sized || model === null || eligible.some(finding => finding.effortMinutes === undefined)
    ? null : technicalDebtRatio(effortMinutes, sized, model);
  return { smells: smells.length, effortMinutes, debtRatio, grade: debtRatio === null ? null : maintainabilityGrade(debtRatio),
    ...(!complete && debtRatio !== null ? { gradeCoverage: { measuredFiles: measured.size, totalFiles } } : {}) };
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
