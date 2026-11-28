import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { isSensitiveFinding } from '@repometry/core/internal/model/finding.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import { findingImportMethods } from '@repometry/core/internal/model/scanner-import.js';

export function nativeScanners(report: Report): readonly { name: string; version: string }[] {
  const scanners = report.appliedConfig.securityScanners;
  if (!Array.isArray(scanners)) return [];
  return scanners.flatMap((scanner: unknown) => isRecord(scanner) && typeof scanner.name === 'string' && typeof scanner.version === 'string'
    ? [{ name: scanner.name, version: scanner.version }] : []);
}

export function securityCounts(report: Report) {
  const imported = findingImportMethods(report.appliedConfig.findingImports).some(({ category }) => isSensitiveFinding(category));
  if (!imported && !nativeScanners(report).length) return undefined;
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  for (const finding of report.findings ?? []) {
    if (isSensitiveFinding(finding.category)) counts[finding.level]++;
  }
  return counts;
}
