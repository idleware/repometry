import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Subject } from '../../../core/model/snapshot.js';
import { isRecord } from '../../../core/engine/plugin.js';
import { commitSummary, needsMaintainabilityRefresh, orderSummaries, repositorySummary } from '../projections/commit-summary.js';
import { summarySchema } from '../wire/summary-model.js';
import type { CommitSummary } from '../wire/summary-model.js';
import { compactJsonSchema } from '../wire/compact-json.js';
import { compareReports, readReport, readStoredReport, validSubjectId } from '../validation/report.js';
import type { Report, ReportStore } from '../validation/report.js';
import { metaManifest } from '../validation/metabranch.js';
import { validateSummaryRow } from '../validation/summary-validation.js';
import { checkDirectory, ensureDirectory, hasCode } from './directory.js';
import { LocalObjectStore } from './object-store.js';
import { replaceFile } from './replace-file.js';
import { ObjectCache, rebuildReport, splitReport, storedReportSchema } from './report-tree.js';
import type { ObjectSource } from './report-tree.js';

const headerStart = `{"schema":"${storedReportSchema}"`;
// Reports saved before objects carried the same summary header under the compact JSON schema.
const summaryHeaders = [headerStart, `{"schema":"${compactJsonSchema}"`].map(start => `${start},"summary":`);

export class LocalReportStore implements ReportStore {
  readonly objects: LocalObjectStore;
  private readonly cache = new ObjectCache();

  constructor(private readonly directory: string) {
    this.objects = new LocalObjectStore(directory);
  }

  async save(report: Report, { deferSummary = false } = {}): Promise<void> {
    readReport(report);
    const base = join(this.directory, subjectFolder(report.subject.kind));
    const folder = this.folder(report.subject);
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await ensureDirectory(base);
    await ensureDirectory(folder);
    const value = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const { stored, objects } = splitReport(value);
    const saved: ObjectSource = { read: async ids => ids.map(id => JSON.parse(objects.get(id)!) as unknown) };
    if (JSON.stringify(await rebuildReport(stored, saved)) !== JSON.stringify(value)) {
      throw new Error(`The store cannot keep report ${report.subject.id} exactly`);
    }
    const row = report.subject.kind === 'commit' ? commitSummary(report) : undefined;
    if (row && !validateSummaryRow(row)) throw new Error(`Invalid report summary: ${report.subject.id}`);
    await replaceFile(this.directory, 'manifest.json', `${JSON.stringify(metaManifest, null, 2)}\n`, true);
    // Objects go first, so a published commit file never names a missing object.
    await this.objects.write(objects);
    // Keep the small index row on the first line of the same atomic file as the report.
    const body = JSON.stringify(stored).slice(1);
    await replaceFile(folder, 'report.json', row ? `${headerStart},"summary":${JSON.stringify(row)},\n${body}\n` : `${headerStart},${body}\n`);
    if (report.subject.kind === 'commit' && !deferSummary) await this.refreshSummary();
  }

  read(subject: Subject): Promise<Report> {
    return this.readWith(subject, this.objects.source(this.cache));
  }

  async list(): Promise<readonly Report[]> {
    const objects = this.objects.source(this.cache);
    const reports: Report[] = [];
    for (const subject of await this.subjects()) {
      try {
        reports.push(await this.readWith(subject, objects));
      } catch (error) {
        // A writer may have created the directory but not published its report yet.
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    return reports.sort(compareReports);
  }

  /** Saved subjects by folder name, whether or not their report is published yet. */
  async subjects(): Promise<readonly Subject[]> {
    const subjects: Subject[] = [];
    for (const kind of ['commit', 'working-tree'] as const) {
      const base = join(this.directory, subjectFolder(kind));
      try {
        await checkDirectory(base);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw error;
      }
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (entry.isDirectory() && validSubjectId(kind, entry.name)) subjects.push({ kind, id: entry.name });
      }
    }
    return subjects;
  }

  /** The saved report file of a subject. */
  async text(subject: Subject): Promise<string> {
    const folder = this.folder(subject);
    const path = join(folder, 'report.json');
    await checkDirectory(join(this.directory, subjectFolder(subject.kind)));
    await checkDirectory(folder);
    if (!(await lstat(path)).isFile()) throw new Error(`Expected a report file: ${path}`);
    return readFile(path, 'utf8');
  }

  async listSummaries(): Promise<readonly CommitSummary[]> {
    const base = join(this.directory, 'commits');
    try {
      await checkDirectory(base);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const entries = await readdir(base, { withFileTypes: true });
    const summaries: CommitSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validSubjectId('commit', entry.name)) continue;
      const subject = { kind: 'commit', id: entry.name } as const;
      const path = join(base, entry.name, 'report.json');
      try {
        if (!(await lstat(path)).isFile()) throw new Error(`Expected a report file: ${path}`);
        summaries.push((await readSummaryHeader(path, subject.id)) ?? commitSummary(await this.read(subject)));
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    return orderSummaries(summaries);
  }

  async refreshSummary(): Promise<void> {
    const path = join(this.directory, 'summary.json');
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Expected a regular summary.json file');
      const current: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(current) || current.schema !== summarySchema) throw new Error('Existing summary.json is not a Repometry summary');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const commits = await this.listSummaries();
      await replaceFile(this.directory, 'summary.json', `${JSON.stringify(repositorySummary(commits))}\n`);
      if (isDeepStrictEqual(commits, await this.listSummaries())) return;
    }
    throw new Error('Reports kept changing during summary publication. The inspection is saved and the summary can be refreshed by retrying.');
  }

  private async readWith(subject: Subject, objects: ObjectSource): Promise<Report> {
    return readStoredReport(await this.text(subject), subject, objects);
  }

  private folder(subject: Subject): string {
    if (!validSubjectId(subject.kind, subject.id)) throw new Error(`Invalid ${subject.kind} ID: ${subject.id}`);
    return join(this.directory, subjectFolder(subject.kind), subject.id);
  }
}

async function readSummaryHeader(path: string, sha: string): Promise<CommitSummary | undefined> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return headerSummary(buffer.toString('utf8', 0, bytesRead), sha);
  } finally {
    await file.close();
  }
}

/** The summary row a saved report keeps on its first line, unless it has none or it needs recalculating. */
export function headerSummary(text: string, sha: string): CommitSummary | undefined {
  const end = text.indexOf('\n');
  if (end < 0) return undefined;
  const first = text.slice(0, end);
  if (!summaryHeaders.some(start => first.startsWith(start)) || !first.endsWith(',')) return undefined;
  const envelope: unknown = JSON.parse(first.slice(0, -1) + '}');
  if (!isRecord(envelope) || !validateSummaryRow(envelope.summary) || envelope.summary.sha !== sha
    || !envelope.summary.revision || envelope.summary.detail !== undefined) throw new Error(`Invalid report summary: ${sha}`);
  return needsMaintainabilityRefresh(envelope.summary) ? undefined : envelope.summary;
}

function subjectFolder(kind: Subject['kind']): string {
  return kind === 'commit' ? 'commits' : 'working-trees';
}
