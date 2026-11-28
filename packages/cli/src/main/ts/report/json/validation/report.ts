import { Ajv2020 } from 'ajv/dist/2020.js';
import metricCatalog from '../../../../resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import schemaV2 from '../../../../resources/report/json/report-v2.schema.json' with { type: 'json' };
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { isMetricDescriptor } from '@repometry/core/internal/engine/manifest.js';
import { isFinding } from '@repometry/core/internal/model/finding.js';
import { canonicalMetricId } from '@repometry/core/internal/model/measurement.js';
import { lcovLines } from '@repometry/core/internal/model/line-coverage.js';
import { digest } from '@repometry/core/internal/model/snapshot.js';
import type { Subject } from '@repometry/core/internal/model/source.js';
import { unpackJson } from '../wire/compact-json.js';
import { rebuildReport, storedReportSchema } from '../store/report-tree.js';
import type { ObjectSource } from '../store/report-tree.js';
import type { CommitSummary } from '../wire/summary-model.js';
import { reportSchema } from '@repometry/core/internal/model/report.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import type { ReportReader as DomainReportReader, ReportWriter } from '@repometry/core/internal/ports/report.js';

export { reportSchema, validSubjectId } from '@repometry/core/internal/model/report.js';
export type { Diagnostic, Report } from '@repometry/core/internal/model/report.js';

export interface ReportReader extends DomainReportReader {
  listSummaries?(): Promise<readonly CommitSummary[]>;
}

export interface ReportStore extends ReportReader, ReportWriter {}

/**
 * Reads a saved report file: a commit file whose rows live in `objects`, or a single-file report saved before
 * objects existed, which is read as it is. Both give the same report.
 */
export async function readStoredReport(text: string, subject: Subject, objects: ObjectSource): Promise<Report> {
  const envelope: unknown = JSON.parse(text);
  const value = isRecord(envelope) && envelope.schema === storedReportSchema ? await rebuildReport(envelope, objects) : unpackJson(envelope);
  const report = readReport(value);
  if (report.subject.kind !== subject.kind || report.subject.id !== subject.id) throw new Error(`Report subject mismatch: ${subject.id}`);
  if (isRecord(envelope) && isRecord(envelope.summary)
    && envelope.summary.revision !== undefined && envelope.summary.revision !== reportRevision(report)) {
    throw new Error(`Report revision mismatch: ${subject.id}`);
  }
  return report;
}

export function reportRevision(report: Report): string {
  return digest(JSON.stringify(report));
}

export function compareReports(a: Report, b: Report): number {
  return b.generatedAt.localeCompare(a.generatedAt) || a.subject.id.localeCompare(b.subject.id);
}

const ajv = new Ajv2020({ schemas: [metricCatalog] });
const validate = ajv.compile<Report>(schemaV2);

export function readReport(value: unknown): Report {
  if (!isRecord(value) || value.schema !== reportSchema) {
    throw new Error('Unsupported or missing report schema');
  }
  if (!validate(value)) throw new Error(`Invalid report: ${ajv.errorsText(validate.errors)}`);
  const definitionIds = Object.keys(value.definitions);
  if (new Set(definitionIds.map(canonicalMetricId)).size !== definitionIds.length) {
    throw new Error('Invalid report: the same measurement uses multiple IDs');
  }
  if (value.pluginData) {
    const { metrics, measured, privateMetrics } = value.pluginData;
    const ids = new Set(metrics.map(metric => metric.id));
    if (new Set([...ids].map(canonicalMetricId)).size !== metrics.length || !metrics.every(isMetricDescriptor)
      || [...measured, ...privateMetrics ?? []].some(id => !ids.has(id))) throw new Error('Invalid report: inconsistent metric catalog');
    const lines = value.pluginData.products[lcovLines.id];
    if (lines && !lcovLines.accepts(lines[0]?.value)) throw new Error('Invalid report: LCOV line ranges must be sorted and merged');
  }
  validateScope(value.scope);
  if (value.findings?.some(finding => !isFinding(finding))) throw new Error('Invalid report: inconsistent finding location');
  const ignore = value.appliedConfig.findingIgnore;
  if (value.ignoredFindings?.some(({ finding, matchedRule }) => !isFinding(finding)
    || !Array.isArray(ignore) || matchedRule >= ignore.length)) throw new Error('Invalid report: inconsistent ignored finding');
  for (const item of value.measurements) {
    if (!Object.hasOwn(value.definitions, item.definition)) throw new Error(`Unknown measurement definition: ${item.definition}`);
    if (item.covered === undefined || item.total === undefined) continue;
    if (item.covered > item.total || item.value !== (item.total === 0 ? null : item.covered / item.total)) {
      throw new Error('Invalid report: inconsistent coverage counts');
    }
  }
  return value;
}

function validateScope({ files, parsed, recovered = 0 }: Report['scope']): void {
  if (parsed > files) throw new Error('Invalid report: parsed count exceeds source count');
  if (recovered > parsed) throw new Error('Invalid report: recovered count exceeds parsed count');
}
