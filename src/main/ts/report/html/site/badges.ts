import { coverageGrade } from '../../../core/model/quality-summary.js';
import type { Grade, QualitySummary } from '../../../core/model/quality-summary.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';

/** The report's own grade colours, so a badge in a README reads as the report does. */
const colors: Record<Grade, string> = { A: '#1f9d5a', B: '#74a83a', C: '#d9a400', D: '#ec8a2c', F: '#db4a3f' };
const unavailable = '#6b7684';
const label = '#0f1720';

export interface SecurityCounts { readonly critical?: number; readonly high: number; readonly medium: number; readonly low: number; readonly unknown: number }

/**
 * The README badges. Security joins coverage and maintainability only where the export may carry scanner counts:
 * the public export leaves them out, and so leaves the badge out.
 */
export function badges(report: PublicHistoryEntry | undefined, quality: QualitySummary | undefined,
  security?: SecurityCounts): Map<string, Buffer> {
  const lines = report?.lineCoverage;
  const ratio = lines && lines.total > 0 ? lines.covered / lines.total : null;
  const grade = quality?.maintainability?.grade ?? null;
  // A missing measurement is one mark, not a word.
  const coverage = ratio === null ? '—'
    : new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
  const files = new Map([
    ['coverage.svg', badge('coverage', coverage, ratio === null ? null : coverageGrade(ratio), 68)],
    ['maintainability.svg', badge('maintainability', grade ?? '—', grade, 112)],
  ]);
  if (security) {
    // A level, not a count: the worst severity found, as one letter on the five-step grade colours.
    const [letter, worst] = security.critical ? ['C', 'F'] as const : security.high ? ['H', 'D'] as const
      : security.medium ? ['M', 'C'] as const : security.low || security.unknown ? ['L', 'B'] as const : ['N', 'A'] as const;
    files.set('security.svg', badge('security', letter, worst, 64));
  }
  return files;
}

function badge(name: string, value: string, grade: Grade | null, labelWidth: number): Buffer {
  const fill = grade ? colors[grade] : unavailable;
  const valueWidth = Math.max(30, value.length * 8 + 14);
  const width = labelWidth + valueWidth;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="26" viewBox="0 0 ${width} 26" role="img" aria-label="${name}: ${value}">
  <rect width="${width}" height="26" rx="5" fill="${fill}"/>
  <path d="M0 5a5 5 0 0 1 5-5h${labelWidth - 5}v26H5a5 5 0 0 1-5-5Z" fill="${label}"/>
  <g fill="#fff" font-family="system-ui,sans-serif" font-size="12" font-weight="600" text-anchor="middle">
    <text x="${labelWidth / 2}" y="17">${name}</text>
    <text x="${labelWidth + valueWidth / 2}" y="17">${value}</text>
  </g>
</svg>\n`);
}
