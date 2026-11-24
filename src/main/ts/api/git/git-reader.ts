import { checkMetaManifest } from '../../report/json/validation/metabranch.js';
import { gitBlobText, gitTreeFiles, resolveGitCommit } from './git.js';
import { qualitySummary } from '../../core/model/quality-summary.js';
import type { Subject } from '../../core/model/snapshot.js';
import { compareReports, readReportText, validSubjectId } from '../../report/json/validation/report.js';
import type { Report, ReportReader } from '../../report/json/validation/report.js';
import { commitSummary, expandSummaryCatalog, needsMaintainabilityRefresh, orderSummaries } from '../../report/json/projections/commit-summary.js';
import type { CommitSummary } from '../../report/json/wire/summary-model.js';
import { validateSummaryIndex } from '../../report/json/validation/summary-validation.js';

export class GitReportReader implements ReportReader {
  private snapshot?: Promise<string>;

  constructor(private readonly directory: string, private readonly revision: string) {}

  async read(subject: Subject): Promise<Report> {
    if (subject.kind !== 'commit' || !validSubjectId('commit', subject.id)) throw new Error('Metabranch reports require a full source commit ID');
    const commit = await this.pinnedSnapshot();
    const path = `commits/${subject.id}/report.json`;
    const entry = (await gitTreeFiles(this.directory, commit, path)).find(item => item.path === path);
    if (!entry) throw Object.assign(new Error(`No report for ${subject.id} in ${this.revision}`), { code: 'ENOENT' });
    return readReportText(await gitBlobText(this.directory, entry.oid), subject);
  }

  async list(): Promise<readonly Report[]> {
    return this.readEntries(await this.reportEntries(await this.pinnedSnapshot()));
  }

  async listSummaries(): Promise<readonly CommitSummary[]> {
    const commit = await this.pinnedSnapshot();
    const [entries, index] = await Promise.all([
      this.reportEntries(commit),
      gitTreeFiles(this.directory, commit, 'summary.json'),
    ]);
    const file = index.find(entry => entry.path === 'summary.json');
    if (file) {
      const value: unknown = JSON.parse(await gitBlobText(this.directory, file.oid));
      if (!validateSummaryIndex(value)) throw new Error(`Invalid Repometry summary in ${this.revision}`);
      const shas = new Set(value.commits.map(row => row.sha));
      if (shas.size === value.commits.length && entries.length === shas.size && entries.every(({ id }) => shas.has(id))
        && value.commits.every(row => row.revision && row.counts && !row.detail)) {
        return this.refreshMaintainability(expandSummaryCatalog(value), entries);
      }
    }
    return orderSummaries((await this.readEntries(entries)).map(commitSummary));
  }

  private refreshMaintainability(rows: readonly CommitSummary[], entries: readonly { id: string; oid: string }[]) {
    if (!rows.some(needsMaintainabilityRefresh)) return rows;
    const blobs = new Map(entries.map(({ id, oid }) => [id, oid]));
    return Promise.all(rows.map(async row => {
      if (!needsMaintainabilityRefresh(row)) return row;
      const report = readReportText(await gitBlobText(this.directory, blobs.get(row.sha)!), { kind: 'commit', id: row.sha });
      return { ...row, quality: { ...row.quality, maintainability: qualitySummary(report).maintainability } };
    }));
  }

  private async reportEntries(commit: string): Promise<{ id: string; oid: string }[]> {
    return (await gitTreeFiles(this.directory, commit, 'commits')).flatMap(({ path, oid }) => {
      const id = /^commits\/([a-f0-9]+)\/report\.json$/.exec(path)?.[1];
      return id && validSubjectId('commit', id) ? [{ id, oid }] : [];
    });
  }

  private async readEntries(entries: readonly { id: string; oid: string }[]): Promise<readonly Report[]> {
    const reports: Report[] = [];
    for (const { id, oid } of entries) {
      reports.push(readReportText(await gitBlobText(this.directory, oid), { kind: 'commit', id }));
    }
    return reports.sort(compareReports);
  }

  private pinnedSnapshot(): Promise<string> {
    this.snapshot ??= this.resolveSnapshot().catch(error => {
      this.snapshot = undefined;
      throw error;
    });
    return this.snapshot;
  }

  private async resolveSnapshot(): Promise<string> {
    const commit = await resolveGitCommit(this.directory, this.revision);
    const entry = (await gitTreeFiles(this.directory, commit, 'manifest.json')).find(item => item.path === 'manifest.json');
    if (!entry) throw new Error(`No Repometry manifest in ${this.revision}`);
    checkMetaManifest(await gitBlobText(this.directory, entry.oid));
    return commit;
  }
}
