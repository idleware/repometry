import { checkMetaManifest } from '../../report/json/validation/metabranch.js';
import { GitBlobReader, gitTreeFiles } from './git.js';
import { qualitySummary } from '../../core/model/quality-summary.js';
import { utf8 } from '../../core/model/snapshot.js';
import type { Subject } from '../../core/model/snapshot.js';
import { compareReports, readStoredReport, validSubjectId } from '../../report/json/validation/report.js';
import { headerSummary } from '../../report/json/store/local-store.js';
import { ObjectCache, objectPath, storedObjects } from '../../report/json/store/report-tree.js';
import type { ObjectSource } from '../../report/json/store/report-tree.js';
import type { Report, ReportReader } from '../../report/json/validation/report.js';
import { commitSummary, expandSummaryCatalog, needsMaintainabilityRefresh, orderSummaries } from '../../report/json/projections/commit-summary.js';
import type { CommitSummary } from '../../report/json/wire/summary-model.js';
import { validateSummaryIndex } from '../../report/json/validation/summary-validation.js';

/** Reads a report store straight from a Git revision of a storage branch, without a checkout. */
export class GitReportReader implements ReportReader {
  private snapshot?: Promise<string>;
  private readonly cache = new ObjectCache();
  private readonly blobs: GitBlobReader;

  constructor(private readonly directory: string, private readonly revision: string) {
    this.blobs = new GitBlobReader(directory);
  }

  async read(subject: Subject): Promise<Report> {
    if (subject.kind !== 'commit' || !validSubjectId('commit', subject.id)) throw new Error('Metabranch reports require a full source commit ID');
    const tree = await this.pinnedSnapshot();
    const text = await this.text(tree, `commits/${subject.id}/report.json`);
    if (text === undefined) throw Object.assign(new Error(`No report for ${subject.id} in ${this.revision}`), { code: 'ENOENT' });
    return readStoredReport(text, subject, this.objects(tree));
  }

  async list(): Promise<readonly Report[]> {
    const reports: Report[] = [];
    for (const id of await this.reportIds(await this.pinnedSnapshot())) reports.push(await this.read({ kind: 'commit', id }));
    return reports.sort(compareReports);
  }

  async listSummaries(): Promise<readonly CommitSummary[]> {
    const tree = await this.pinnedSnapshot();
    const [ids, index] = await Promise.all([this.reportIds(tree), this.text(tree, 'summary.json')]);
    if (index !== undefined) {
      const value: unknown = JSON.parse(index);
      if (!validateSummaryIndex(value)) throw new Error(`Invalid Repometry summary in ${this.revision}`);
      const shas = new Set(value.commits.map(row => row.sha));
      if (shas.size === value.commits.length && ids.length === shas.size && ids.every(id => shas.has(id))
        && value.commits.every(row => row.revision && row.counts && !row.detail)) {
        return this.refreshMaintainability(expandSummaryCatalog(value));
      }
    }
    // Without a complete summary.json, each report's first line carries its summary row.
    const rows: CommitSummary[] = [];
    for (const id of ids) {
      const text = await this.text(tree, `commits/${id}/report.json`);
      if (text !== undefined) rows.push(headerSummary(text, id) ?? commitSummary(await readStoredReport(text, { kind: 'commit', id }, this.objects(tree))));
    }
    return orderSummaries(rows);
  }

  private refreshMaintainability(rows: readonly CommitSummary[]) {
    if (!rows.some(needsMaintainabilityRefresh)) return rows;
    return Promise.all(rows.map(async row => {
      if (!needsMaintainabilityRefresh(row)) return row;
      const report = await this.read({ kind: 'commit', id: row.sha });
      return { ...row, quality: { ...row.quality, maintainability: qualitySummary(report).maintainability } };
    }));
  }

  private async reportIds(tree: string): Promise<string[]> {
    return (await gitTreeFiles(this.directory, tree, 'commits')).flatMap(({ path }) => {
      const id = /^commits\/([a-f0-9]+)\/report\.json$/.exec(path)?.[1];
      return id && validSubjectId('commit', id) ? [id] : [];
    });
  }

  private async text(tree: string, path: string): Promise<string | undefined> {
    const [blob] = await this.blobs.read([`${tree}:${path}`]);
    return blob === undefined ? undefined : utf8(blob);
  }

  private objects(tree: string): ObjectSource {
    return treeObjects(this.blobs, tree, this.cache);
  }

  private pinnedSnapshot(): Promise<string> {
    this.snapshot ??= this.resolveSnapshot().catch(error => {
      this.snapshot = undefined;
      throw error;
    });
    return this.snapshot;
  }

  private async resolveSnapshot(): Promise<string> {
    const tree = await pinnedTree(this.blobs, this.directory, this.revision);
    const manifest = await this.text(tree, 'manifest.json');
    if (manifest === undefined) throw new Error(`No Repometry manifest in ${this.revision}`);
    checkMetaManifest(manifest);
    return tree;
  }
}

/** Report objects as a storage branch revision holds them, to read or to restore a local store from. */
export async function gitReportObjects(directory: string, revision: string): Promise<ObjectSource> {
  const blobs = new GitBlobReader(directory);
  return treeObjects(blobs, await pinnedTree(blobs, directory, revision));
}

/** The tree a revision names, a commit's root tree or the tree itself, so later reads cannot move with the branch. */
async function pinnedTree(blobs: GitBlobReader, directory: string, revision: string): Promise<string> {
  const tree = await blobs.id(`${revision}^{tree}`);
  if (tree === undefined) throw new Error(`${revision} is not a commit or tree in ${directory}`);
  return tree;
}

function treeObjects(blobs: GitBlobReader, tree: string, cache?: ObjectCache): ObjectSource {
  return storedObjects(ids => blobs.read(ids.map(id => `${tree}:${objectPath(id)}`)), cache);
}
