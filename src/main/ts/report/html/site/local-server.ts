import { reportRevision, validSubjectId } from '../../json/validation/report.js';
import type { Report, ReportReader } from '../../json/validation/report.js';
import { siteFiles, siteSummary } from './export-site.js';
import type { SiteOptions } from './export-site.js';
import { fileMetrics } from '../../json/projections/file-metrics.js';
import { inspectionHistory } from '../../json/projections/inspection-context.js';
import { complexFunctions, inspectionAsset, inspectionDetails } from '../../json/projections/inspection-details.js';
import { packJson } from '../../json/wire/compact-json.js';
import { withCommitMetadata } from '../../json/projections/commit-summary.js';

import { serveAssets } from './server.js';
import { sourceResponse } from './source-route.js';
import type { SourceAccess } from './source-route.js';

export async function serveSite(reader: ReportReader, port: number,
  options: Omit<SiteOptions, 'mode'> = {}, source?: SourceAccess): Promise<{ url: string; close: () => void }> {
  const indexed = await reader.listSummaries?.();
  const reports = indexed ? [] : await reader.list();
  const siteOptions = { ...options, mode: 'local' } as const;
  const files = await siteFiles(reports, siteOptions, indexed);
  const commits = new Map(reports.filter(report => report.subject.kind === 'commit').map(report => [report.subject.id, report]));
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
      return siteSummary(await withCommitMetadata(await reader.listSummaries(), options.readCommitMetadata), siteOptions);
    }
    if (name === 'inspection-context.json') return Buffer.from(JSON.stringify(inspectionHistory(indexed ? await reader.list() : reports)));
    const versioned = /^inspection\/([a-f0-9]+)-([a-f0-9]{64})\.json$/.exec(name);
    if (versioned) {
      const inspection = await read(versioned[1]!);
      return inspection && reportRevision(inspection) === versioned[2]
        ? Buffer.from(JSON.stringify(packJson(inspectionAsset(inspection, options.components)))) : undefined;
    }
    const resource = /^(files|details|functions)\/([a-f0-9]+)\.json$/.exec(name);
    if (!resource) return files.get(name);
    const inspection = await read(resource[2]!);
    if (!inspection) return undefined;
    const value = resource[1] === 'files' ? fileMetrics(inspection)
      : resource[1] === 'functions' ? complexFunctions(inspection).slice(0, 5) : inspectionDetails(inspection, options.components);
    return Buffer.from(JSON.stringify(value));
  }
  return serveAssets(port, asset, source?.close);
}

function sourceListed(report: Report, path: string): boolean {
  return (report.pluginData?.inventory ?? []).some(file => file.path === path)
    || report.measurements.some(row => row.path === path)
    || report.diagnostics.some(row => row.path === path)
    || (report.findings ?? []).some(row => row.path === path || row.related?.some(location => location.path === path));
}
