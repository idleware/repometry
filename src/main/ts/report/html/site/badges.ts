import { coverageGrade, securityGrade } from '../../../core/model/quality-summary.js';
import type { Grade, QualitySummary } from '../../../core/model/quality-summary.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';

/** The report's own grade colours, so a badge in a README reads as the report does. */
const colors: Record<Grade, string> = { A: '#1f9d5a', B: '#74a83a', C: '#d9a400', D: '#ec8a2c', F: '#db4a3f' };
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
  const labelWidth = Math.max(11, name.length * 7) + 12;
  const valueWidth = Math.max(11, value.length * 7) + 12;
  const width = labelWidth + valueWidth;
  const labelCenter = labelWidth / 2;
  const valueCenter = labelWidth + valueWidth / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${name}: ${value}">
  <defs>
    <clipPath id="badge"><rect width="${width}" height="20" rx="3"/></clipPath>
    <linearGradient id="shade" x2="0" y2="100%">
      <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
      <stop offset="1" stop-color="#000" stop-opacity=".1"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#badge)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${fill}"/>
    <rect width="${width}" height="20" fill="url(#shade)"/>
  </g>
  <g aria-hidden="true" fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${labelCenter}" y="15" fill="#010101" fill-opacity=".3">${name}</text>
    <text x="${valueCenter}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelCenter}" y="14">${name}</text>
    <text x="${valueCenter}" y="14">${value}</text>
  </g>
</svg>\n`);
}
