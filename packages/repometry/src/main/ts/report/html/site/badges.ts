import { coverageGrade, securityGrade } from '../../../core/model/quality-summary.js';
import type { Grade, QualitySummary } from '../../../core/model/quality-summary.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';

const colors: Record<Grade, string> = { A: '#5ec269', B: '#74a83a', C: '#d9a400', D: '#ec8a2c', F: '#db4a3f' };
const unavailable = '#6b7684';

export interface SecurityCounts { readonly critical?: number; readonly high: number; readonly medium: number; readonly low: number; readonly unknown: number }

/** The README badges. Security is available when the inspection recorded scanner counts. */
export function badges(report: PublicHistoryEntry | undefined, quality: QualitySummary | undefined,
  security?: SecurityCounts): Map<string, Buffer> {
  const lines = report?.lineCoverage;
  const ratio = lines && lines.total > 0 ? lines.covered / lines.total : null;
  const grade = quality?.maintainability?.grade ?? null;
  const coverage = lines && lines.total > 0 ? `${BigInt(lines.covered) * 100n / BigInt(lines.total)}%` : '—';
  const files = new Map([
    ['coverage.svg', badge('coverage', coverage, ratio === null ? null : coverageGrade(ratio))],
    ['maintainability.svg', badge('maintainability', grade ?? '—', grade)],
  ]);
  if (security) {
    const grade = securityGrade(security);
    files.set('security.svg', badge('security', grade, grade));
  }
  return files;
}

function badge(name: string, value: string, grade: Grade | null): Buffer {
  const fill = grade ? colors[grade] : unavailable;
  const labelTextWidth = Math.round(textWidth(name));
  const valueTextWidth = Math.round(textWidth(value) * 1.12);
  const padding = 7;
  const labelWidth = labelTextWidth + 2 * padding;
  const valueWidth = valueTextWidth + 2 * padding;
  const width = labelWidth + valueWidth;
  const clipId = `${name}-clip`;
  const labelId = `${name}-label`;
  const valueId = `${name}-value`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${name}: ${value}">
  <defs>
    <clipPath id="${clipId}"><rect width="${width}" height="20" rx="3"/></clipPath>
    <linearGradient id="${labelId}" x2="0" y2="100%">
      <stop stop-color="#475265"/>
      <stop offset="1" stop-color="#3a4557"/>
    </linearGradient>
    <linearGradient id="${valueId}" x2="0" y2="100%">
      <stop stop-color="#fff" stop-opacity=".06"/>
      <stop offset="1" stop-color="#000" stop-opacity=".06"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#${clipId})">
    <rect width="${labelWidth}" height="20" fill="url(#${labelId})"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${fill}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="url(#${valueId})"/>
  </g>
  <g aria-hidden="true" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif" font-size="11">
    <text x="${padding}" y="14" font-weight="400" textLength="${labelTextWidth}" lengthAdjust="spacingAndGlyphs">${name}</text>
    <text x="${labelWidth + padding}" y="14" font-weight="700" textLength="${valueTextWidth}" lengthAdjust="spacingAndGlyphs">${value}</text>
  </g>
</svg>\n`);
}

function textWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (/[ijl]/.test(character)) width += 3.4;
    else if (/[mwMW]/.test(character)) width += 7.6;
    else if (/[A-Z]/.test(character)) width += 7.4;
    else if (/[0-9%]/.test(character)) width += 6.6;
    else if (character === '—') width += 11;
    else width += 6.2;
  }
  return width;
}
