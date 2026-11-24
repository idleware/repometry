import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Subject } from '../../../core/model/snapshot.js';
import { isRecord } from '../../../core/engine/plugin.js';
import { commitSummary, orderSummaries, repositorySummary } from '../projections/commit-summary.js';
import { summarySchema } from '../wire/summary-model.js';
import type { CommitSummary } from '../wire/summary-model.js';
import { compactJsonSchema, packJson } from '../wire/compact-json.js';
import { compareReports, readReport, readReportText, validSubjectId } from '../validation/report.js';
import type { Report, ReportStore } from '../validation/report.js';
import { validateSummaryRow } from '../validation/summary-validation.js';
import { replaceFile } from './replace-file.js';

const packedHeader = `{"schema":"${compactJsonSchema}","summary":`;

export class LocalReportStore implements ReportStore {
  constructor(private readonly directory: string) {}

  async save(report: Report): Promise<void> {
    readReport(report);
    const base = join(this.directory, subjectFolder(report.subject.kind));
    const folder = this.folder(report.subject);
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await ensureDirectory(base);
    await ensureDirectory(folder);
    const packed = packJson(JSON.parse(JSON.stringify(report)) as unknown);
    const { strings, shapes, data } = packed;
    const row = report.subject.kind === 'commit' ? commitSummary(report) : undefined;
    if (row && !validateSummaryRow(row)) throw new Error(`Invalid report summary: ${report.subject.id}`);
    // Keep the small index row on the first line of the same atomic file as the report.
    const contents = row
      ? `${packedHeader}${JSON.stringify(row)},\n${JSON.stringify({ strings, shapes, data }).slice(1)}\n`
      : `${JSON.stringify(packed)}\n`;
    await replaceFile(folder, 'report.json', contents);
    if (report.subject.kind === 'commit') await this.refreshSummary();
  }

  async read(subject: Subject): Promise<Report> {
    const folder = this.folder(subject);
    const path = join(folder, 'report.json');
    await checkDirectory(join(this.directory, subjectFolder(subject.kind)));
    await checkDirectory(folder);
    if (!(await lstat(path)).isFile()) throw new Error(`Expected a report file: ${path}`);
    return readReportText(await readFile(path, 'utf8'), subject);
  }

  async list(): Promise<readonly Report[]> {
    const reports: Report[] = [];
    for (const kind of ['commit', 'working-tree'] as const) {
      const base = join(this.directory, subjectFolder(kind));
      try {
        await checkDirectory(base);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw error;
      }
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validSubjectId(kind, entry.name)) continue;
        try {
          reports.push(await this.read({ kind, id: entry.name }));
        } catch (error) {
          // A writer may have created the directory but not published its report yet.
          if (!hasCode(error, 'ENOENT')) throw error;
        }
      }
    }
    return reports.sort(compareReports);
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

  private async refreshSummary(): Promise<void> {
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

  private folder(subject: Subject): string {
    if (!validSubjectId(subject.kind, subject.id)) throw new Error(`Invalid ${subject.kind} ID: ${subject.id}`);
    return join(this.directory, subjectFolder(subject.kind), subject.id);
  }
}

async function readSummaryHeader(path: string, sha: string): Promise<CommitSummary | undefined> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return undefined;
    const first = buffer.toString('utf8', 0, end);
    if (!first.startsWith(packedHeader) || !first.endsWith(',')) return undefined;
    const envelope: unknown = JSON.parse(first.slice(0, -1) + '}');
    if (!isRecord(envelope) || !validateSummaryRow(envelope.summary) || envelope.summary.sha !== sha
      || !envelope.summary.revision || envelope.summary.detail !== undefined) throw new Error(`Invalid report summary: ${sha}`);
    return envelope.summary;
  } finally {
    await file.close();
  }
}

function subjectFolder(kind: Subject['kind']): string {
  return kind === 'commit' ? 'commits' : 'working-trees';
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await checkDirectory(path);
}

async function checkDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a directory: ${path}`);
}
