import { definitions } from '../core/model/measurement.js';
import type { Measurement } from '../core/model/measurement.js';
import type { Report } from '../report/json/validation/report.js';
import { reportSchema } from '../report/json/validation/report.js';
import { gitText } from '../api/git/git.js';
import { churnSettings, gitChurn } from '../api/git/git-churn.js';

export async function attachChurn(report: Report, root: string, paths: readonly string[]): Promise<Report> {
  if (report.subject.kind !== 'commit') return report;
  if (paths.length === 0) return withCommitTime(report, root);
  const { churnWindow, ...appliedConfig } = report.appliedConfig;
  const settings = { ...appliedConfig, churn: churnSettings };
  const measurements = report.measurements.filter(row => row.definition !== definitions.churn);
  const diagnostics = report.diagnostics.filter(row => row.operation !== 'git/churn');

  try {
    const churn = await gitChurn(root, report.subject.id, paths);
    const rows: Measurement[] = [...churn.touches].map(([path, value]) => ({ definition: definitions.churn, target: 'file', path, value }));
    const status = report.status === 'partial' && diagnostics.length === 0 && report.diagnostics.length > 0 ? 'complete' : report.status;
    return {
      ...report,
      appliedConfig: { ...settings, churnWindow: churn.window },
      definitions: { ...report.definitions, [definitions.churn]:
        'First-parent commits that touched the current path, in the 90 days ending at the inspected commit. Root snapshots are omitted and renames start a new path.' },
      status,
      measurements: [...measurements, ...rows],
      diagnostics,
    };
  } catch {
    return withCommitTime({ ...report, appliedConfig: settings, status: 'partial', measurements, diagnostics: [...diagnostics,
      { operation: 'git/churn', state: 'partial', message: 'Could not measure changes in the Git history available locally.' }] }, root);
  }
}

async function withCommitTime(report: Report, root: string): Promise<Report> {
  const timestamp = await gitText(root, ['show', '--no-show-signature', '--no-notes', '--no-patch', '--format=%cI', report.subject.id, '--'])
    .catch(() => '');
  const time = Date.parse(timestamp.trim());
  return Number.isFinite(time) ? { ...report, schema: reportSchema, committedAt: new Date(time).toISOString() } : report;
}
