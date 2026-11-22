import { qualitySummary } from '../../../core/model/quality-summary.js';
import { historyEntry } from './commit-summary.js';
import type { Report } from '../validation/report.js';
import { historySchema } from '../wire/public-history-model.js';
import type { PublicHistory, QualityHistory } from '../wire/public-history-model.js';

export function publicHistory(reports: readonly Report[]): PublicHistory {
  return {
    schema: historySchema,
    reports: reports.filter(report => report.subject.kind === 'commit').map(historyEntry),
  };
}

export function qualityHistory(reports: readonly Report[]): QualityHistory {
  return {
    schema: 'urn:repometry:schema:quality-history:1',
    reports: Object.fromEntries(reports.filter(report => report.subject.kind === 'commit')
      .map(report => [report.subject.id, qualitySummary(report)])),
  };
}

