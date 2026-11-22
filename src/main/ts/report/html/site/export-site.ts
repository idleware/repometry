import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historySchema } from '../../json/wire/public-history-model.js';
import { inspectionAsset } from '../../json/projections/inspection-details.js';
import { isRecord } from '../../../core/engine/plugin.js';
import { commitSummary, orderSummaries, repositorySummary, withCommitMetadata } from '../../json/projections/commit-summary.js';
import type { ReadCommitMetadata } from '../../json/projections/commit-summary.js';
import type { CommitSummary, SourceLocator } from '../../json/wire/summary-model.js';
import { packJson } from '../../json/wire/compact-json.js';
import { comparePaths, digest } from '../../../core/model/snapshot.js';
import type { Report, ReportReader } from '../../json/validation/report.js';
import { pullReviewsSchema } from '../../json/wire/pull-review-model.js';
import type { PullReview } from '../../json/wire/pull-review-model.js';
import type { Component } from '../../json/projections/components.js';
import { badges } from './badges.js';

const appDirectory = new URL('../app/', import.meta.url);
const wireDirectory = new URL('../../json/wire/', import.meta.url);
const resourceDirectory = new URL('../../../../resources/viewer/', import.meta.url);

async function listViewerAssets() {
  const groups = await Promise.all([
    listAssets(appDirectory, name => name.endsWith('.js')),
    listAssets(wireDirectory, name => name.endsWith('.js')),
    listAssets(resourceDirectory, name => name.endsWith('.css') || name === 'index.html'),
  ]);
  const assets = groups.flat().sort(([left], [right]) => comparePaths(left, right));
  if (new Set(assets.map(([name]) => name)).size !== assets.length) {
    throw new Error('The build contains duplicate viewer asset names');
  }
  return assets;
}

async function listAssets(directory: URL, include: (name: string) => boolean) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && include(entry.name))
    .map(({ name }) => [name, new URL(encodeURIComponent(name), directory)] as const);
}

export interface SiteOptions {
  readonly title?: string;
  readonly mode?: 'public' | 'local' | 'private';
  readonly components?: readonly Component[];
  readonly pulls?: readonly PullReview[];
  readonly sources?: SourceLocator;
  readonly branch?: string;
  readonly readCommitMetadata?: ReadCommitMetadata;
  /** The page footer with the project link and license; --no-footer leaves it out. */
  readonly footer?: boolean;
}

/** A page without its footer, for reports published under someone else's name. */
export function withoutFooter(html: string): string {
  return html.replace(/\n[ \t]*<footer class="site-footer">[\s\S]*?<\/footer>/, '');
}

export async function siteFiles(reports: readonly Report[],
  { title = '', mode = 'public', components, pulls = [], sources, branch, readCommitMetadata, footer = true }: SiteOptions = {},
  indexed?: readonly CommitSummary[]): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>(await Promise.all((await listViewerAssets()).map(async ([name, source]) => {
    const bytes = await readFile(source);
    // The published viewer keeps its existing flat URLs for static hosts and open tabs.
    const contents = source.href.startsWith(appDirectory.href)
      ? Buffer.from(bytes.toString('utf8').replace(/(\b(?:from|import)\s*['"]|\bimport\(\s*['"])\.\.\/\.\.\/json\/wire\//g, '$1./'))
      : bytes;
    return [name, contents] as const;
  })));
  const index = files.get('index.html')!.toString('utf8')
    .replace('name="repometry-view" content="public"', `name="repometry-view" content="${mode}"`)
    .replace('name="repometry-project" content=""', () => `name="repometry-project" content="${escapeAttribute(title)}"`);
  files.set('index.html', Buffer.from(footer ? index : withoutFooter(index)));
  const commits = reports.filter(report => report.subject.kind === 'commit');
  const rows = orderSummaries(await withCommitMetadata(indexed ?? commits.map(commitSummary), readCommitMetadata));
  const publicRows = rows.map(({ quality, counts, detail, revision, profileDigest, profileBoundary, subject, author, tags,
    metrics, values, privateMetrics, ...history }) => ({ ...history, subject, author: author && { name: author.name }, tags }));
  const history = { schema: historySchema, reports: publicRows };
  const quality = { schema: 'urn:repometry:schema:quality-history:1',
    reports: Object.fromEntries(rows.map(row => [row.sha, row.quality])) };
  files.set('history.json', Buffer.from(`${JSON.stringify(history)}\n`));
  files.set('quality-history.json', Buffer.from(`${JSON.stringify(quality)}\n`));
  const latest = rows[0];
  // Scanner counts stay out of the public export, and so does their badge.
  for (const [name, data] of badges(latest, latest?.quality, mode === 'public' ? undefined : latest?.counts?.security)) files.set(name, data);
  if (mode !== 'public') files.set('pulls.json', Buffer.from(`${JSON.stringify({ schema: pullReviewsSchema, reviews: pulls })}\n`));
  const details = new Map<string, string>();
  if (mode === 'private') {
    for (const report of commits) {
      const sha = report.subject.id;
      const data = JSON.stringify(packJson(inspectionAsset(report, components))) + '\n';
      const name = `details/${sha}-${digest(data)}.json`;
      details.set(sha, name);
      files.set(name, Buffer.from(data));
    }
  }
  files.set('summary.json', siteSummary(rows, { mode, components, pulls, sources, branch }, details));
  return files;
}

export function siteSummary(rows: readonly CommitSummary[], { mode = 'public', components, pulls = [], sources, branch }: SiteOptions,
  details = new Map<string, string>()): Buffer {
  const ordered = orderSummaries(rows);
  const commits = ordered.map(({ counts, detail, revision, profileDigest, profileBoundary, subject, author, tags, ...row }, index): CommitSummary => {
    if (mode === 'public') return { ...row, subject, author: author && { name: author.name }, tags };
    const previous = ordered[index + 1];
    const boundary = !previous ? undefined : !profileDigest || !previous.profileDigest ? 'unavailable'
      : profileDigest === previous.profileDigest ? undefined : 'changed';
    return {
      ...row, subject, author, tags, detail: mode === 'local' && revision ? `inspection/${row.sha}-${revision}.json` : details.get(row.sha),
      counts: counts && { ...counts, componentCount: components?.length ?? 0 },
      ...(boundary === undefined ? {} : { profileBoundary: boundary }),
    };
  });
  const summary = repositorySummary(commits, mode === 'public' ? undefined : pulls.length, mode !== 'public');
  return Buffer.from(`${JSON.stringify({ ...summary, ...(branch === undefined ? {} : { source: { branch } }),
    ...(mode !== 'public' && sources ? { sources } : {}) })}\n`);
}

export async function exportSite(reader: ReportReader, destination: string, options: SiteOptions = {}): Promise<void> {
  const indexed = options.mode === 'private' ? undefined : await reader.listSummaries?.();
  const files = await siteFiles(indexed ? [] : await reader.list(), options, indexed);
  await mkdir(destination, { recursive: true, mode: options.mode === 'private' ? 0o700 : 0o755 });
  if (!(await lstat(destination)).isDirectory()) throw new Error('The viewer destination must be a directory');
  const entries = await readdir(destination, { withFileTypes: true });
  const privateExport = options.mode === 'private';
  const oldDetails = privateExport && entries.some(entry => entry.name === 'details.json' && entry.isFile());
  const detailDirectory = entries.some(entry => entry.name === 'details' && entry.isDirectory());
  if (entries.some(entry => !(entry.isFile() && files.has(entry.name))
    && !(privateExport && entry.name === 'details' && entry.isDirectory())
    && !(oldDetails && entry.name === 'details.json' && entry.isFile()))) {
    throw new Error('Use a dedicated viewer destination containing only Repometry export files');
  }
  if (oldDetails) {
    const legacy: unknown = JSON.parse(await readFile(join(destination, 'details.json'), 'utf8'));
    if (!isRecord(legacy) || legacy.schema !== 'urn:repometry:schema:viewer-details:1') {
      throw new Error('Existing details.json is not a Repometry export');
    }
  }
  if (detailDirectory) {
    const existing = await readdir(join(destination, 'details'), { withFileTypes: true });
    if (existing.some(entry => !entry.isFile() || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}\.json$/.test(entry.name))) {
      throw new Error('The viewer details directory contains files outside the export');
    }
  }
  if (entries.length > 0) {
    const existing: unknown = entries.some(entry => entry.name === 'history.json')
      ? JSON.parse(await readFile(join(destination, 'history.json'), 'utf8')) : undefined;
    if (!isRecord(existing) || existing.schema !== historySchema) throw new Error('Choose an empty viewer directory or an existing Repometry export');
  }

  const staging = join(destination, `.export-${randomUUID()}`);
  await mkdir(staging);
  try {
    const hasDetails = [...files.keys()].some(name => name.startsWith('details/'));
    if (hasDetails) await mkdir(join(staging, 'details'), { mode: 0o700 });
    for (const [name, bytes] of files) {
      const mode = name.startsWith('details/') || name === 'pulls.json' || (privateExport && name === 'summary.json') ? 0o600 : 0o644;
      await writeFile(join(staging, name), bytes, { mode });
    }
    const afterDependencies = ['viewer.js', 'summary.json', 'index.html'];
    const install = (name: string) => rename(join(staging, name), join(destination, name));
    await install('history.json');
    if (hasDetails && !detailDirectory) await mkdir(join(destination, 'details'), { mode: 0o700 });
    for (const name of files.keys()) {
      if (name !== 'history.json' && !afterDependencies.includes(name)) await install(name);
    }
    for (const name of afterDependencies) await install(name);
    if (oldDetails) await rm(join(destination, 'details.json'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
