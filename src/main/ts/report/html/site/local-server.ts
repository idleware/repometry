import { reportRevision, validSubjectId } from '../../json/validation/report.js';
import type { Report, ReportReader } from '../../json/validation/report.js';
import { siteSummary, viewerAssets } from './export-site.js';
import type { SiteOptions } from './export-site.js';
import { inspectionAsset } from '../../json/projections/inspection-details.js';
import { packJson } from '../../json/wire/compact-json.js';
import { commitSummary, orderSummaries, withCommitMetadata } from '../../json/projections/commit-summary.js';
import type { CommitSummary } from '../../json/wire/summary-model.js';

import { serveAssets } from './server.js';
import { sourceResponse } from './source-route.js';
import type { SourceAccess } from './source-route.js';

export async function serveSite(reader: ReportReader, port: number,
  options: SiteOptions = {}, source?: SourceAccess): Promise<{ url: string; close: () => void }> {
  const indexed = await reader.listSummaries?.();
  const reports = indexed ? [] : await reader.list();
  const commits = new Map(reports.filter(report => report.subject.kind === 'commit').map(report => [report.subject.id, report]));
  const rows = orderSummaries(await withCommitMetadata(indexed ?? [...commits.values()].map(commitSummary), options.readCommitMetadata));
  const files = await viewerAssets(rows, options);
  files.set('index.html', Buffer.from(files.get('index.html')!.toString('utf8')
    .replace('name="repometry-view" content="private"', 'name="repometry-view" content="local"')));
  files.set('summary.json', siteSummary(rows, options, liveInspectionPath));
  async function read(sha: string): Promise<Report | undefined> {
    if (!validSubjectId('commit', sha)) return undefined;
    if (!indexed) return commits.get(sha);
    try {
      return await reader.read({ kind: 'commit', id: sha });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async function asset(name: string): Promise<Uint8Array | undefined> {
    if (name.startsWith('sources/')) return sourceResponse(name, source, async (revision, path) => {
      const report = await read(revision);
      return report !== undefined && sourceListed(report, path);
    });
    if (name === 'summary.json' && reader.listSummaries) {
      return siteSummary(await withCommitMetadata(await reader.listSummaries(), options.readCommitMetadata), options, liveInspectionPath);
    }
    const versioned = /^inspection\/([a-f0-9]+)-([a-f0-9]{64})\.json$/.exec(name);
    if (versioned) {
      const inspection = await read(versioned[1]!);
      return inspection && reportRevision(inspection) === versioned[2]
        ? Buffer.from(JSON.stringify(packJson(inspectionAsset(inspection, options.components)))) : undefined;
    }
    return files.get(name);
  }
  return serveAssets(port, asset, source?.close);
}

function liveInspectionPath({ sha, revision }: CommitSummary): string | undefined {
  return revision === undefined ? undefined : `inspection/${sha}-${revision}.json`;
}

function sourceListed(report: Report, path: string): boolean {
  return (report.pluginData?.inventory ?? []).some(file => file.path === path)
    || report.measurements.some(row => row.path === path)
    || report.diagnostics.some(row => row.path === path)
    || (report.findings ?? []).some(row => row.path === path || row.related?.some(location => location.path === path));
}
