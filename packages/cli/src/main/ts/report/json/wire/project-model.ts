import type { QualitySummary } from '@repometry/core/internal/model/quality-summary.js';
import type { PublicHistoryEntry } from './public-history-model.js';

export interface ProjectEntry {
  readonly name: string;
  readonly inspection: PublicHistoryEntry | null;
  readonly quality: QualitySummary | null;
}
