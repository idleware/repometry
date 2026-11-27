import { Ajv2020 } from 'ajv/dist/2020.js';
import metricCatalog from '../../../../resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import summaryContract from '../../../../resources/report/json/repository-summary-v1.schema.json' with { type: 'json' };
import { summarySchema } from '../wire/summary-model.js';
import type { CommitSummary, RepositorySummary } from '../wire/summary-model.js';
import type { MetricDescriptor } from '../wire/summary-model.js';
import { isMetricDescriptor } from '../../../core/engine/manifest.js';

const validator = new Ajv2020({ schemas: [metricCatalog, summaryContract] });

export const validateSummary = validator.compile<RepositorySummary>(summaryContract);
const rowShape = validator.compile<CommitSummary>({ $ref: `${summarySchema}#/$defs/commit` });

export function validateSummaryIndex(value: unknown): value is RepositorySummary {
  return validateSummary(value) && validCatalog(value.metrics, value.privateMetrics)
    && value.commits.every(row => validCatalog(row.metrics, row.privateMetrics) && validPositions(row, value.metrics));
}

export function validateSummaryRow(value: unknown): value is CommitSummary {
  return rowShape(value) && validCatalog(value.metrics, value.privateMetrics) && validPositions(value);
}

function validCatalog(catalog: readonly MetricDescriptor[] | undefined, privateMetrics: readonly string[] = []): boolean {
  if (catalog && !catalog.every(isMetricDescriptor)) return false;
  const ids = new Set(catalog?.map(metric => metric.id));
  return ids.size === (catalog?.length ?? 0) && privateMetrics.every(id => ids.has(id));
}

function validPositions(row: CommitSummary, fallback?: readonly MetricDescriptor[]): boolean {
  const count = (row.metrics ?? fallback)?.length ?? 0;
  return Object.keys(row.values ?? {}).every(key => Number(key) < count);
}
