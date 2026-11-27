import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { commitMetadataReader } from '../api/git/commit-metadata.js';
import { readLocalSources, sourceRemotes } from '../api/git/local-sources.js';
import { defaultLanguages, languageRegistry } from '../compose/languages.js';
import { resolveSourceLocator } from '../compose/sources.js';
import { commitSummary, withCommitMetadata } from '../report/json/projections/commit-summary.js';
import { exportSite, siteSummary } from '../report/html/site/export-site.js';
import { readExportedSummary, serveExportedSite } from '../report/html/site/exported-server.js';
import { serveSite } from '../report/html/site/local-server.js';
import { listPullReviews } from '../report/json/store/pull-review-store.js';
import { readConfig } from './config.js';
import type { Invocation } from './arguments.js';
import { findRepository, invocationDirectory, isDirectory, selectStore } from './store.js';
import type { Store } from './store.js';

const reporters = { html: '.repometry/report/html', json: '.repometry/report/summary.json' } as const;
export const reporterIds = Object.keys(reporters);

type Config = Awaited<ReturnType<typeof readConfig>>;

function reportLanguages({ plugins, parsers }: Config) {
  return plugins.length || parsers ? languageRegistry(plugins, true, parsers) : defaultLanguages;
}

export async function outputReports(root: string, store: Store, input: Invocation, config: Config) {
  const typed = input.args.length > 0;
  const base = typed ? invocationDirectory(input) : root;
  const configured = config.reports.length ? config.reports : ['html'];
  const requested = typed ? input.args : configured;
  const requests = requested.map(spec => {
    const equal = spec.indexOf('=');
    const format = equal < 0 ? spec : spec.slice(0, equal);
    const path = equal < 0 ? undefined : spec.slice(equal + 1);
    if (!Object.hasOwn(reporters, format)) throw new Error(`Unknown reporter: ${format}. Choose ${reporterIds.join(', ')}.`);
    if (path === '') throw new Error('Expected an output path after FORMAT=');
    const name = format as keyof typeof reporters;
    return { format: name, path: path === undefined ? resolve(root, reporters[name]) : resolve(base, path) };
  });
  if (new Set(requests.map(request => request.path)).size !== requests.length) throw new Error('Each report requires a separate output');
  const repository = await findRepository(root);
  const readCommitMetadata = repository === undefined ? undefined : commitMetadataReader(repository);
  const sourceOption = input.text('sources') ?? config.sources;
  const sources = resolveSourceLocator(sourceOption, { remotes: await sourceRemotes(root), env: process.env });
  const pulls = store.path ? await listPullReviews(store.path) : [];
  const options = { languages: reportLanguages(config), sources,
    components: config.components, pulls, readCommitMetadata, branch: input.text('branch') ?? config.branch,
    title: input.text('title') ?? basename(root) };
  for (const request of requests) {
    if (request.format === 'html') await exportSite(store.reader, request.path, options);
    else {
      const rows = await store.reader.listSummaries?.() ?? (await store.reader.list()).filter(report => report.subject.kind === 'commit').map(commitSummary);
      const data = siteSummary(await withCommitMetadata(rows, readCommitMetadata), options);
      await writeSummary(request.path, data);
    }
  }
  return requests;
}

async function writeSummary(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o644, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function viewTarget(input: Invocation, port: number) {
  const target = resolve(input.args[0] ?? '.');
  const storeOption = input.text('store');
  const exported = storeOption === undefined ? await readExportedSummary(target) : undefined;
  const repository = await findRepository(target);
  if (exported) {
    const local = exported.sources?.provider === 'local' && repository ? readLocalSources(repository) : undefined;
    return { ...await serveExportedSite(target, port, local), label: target + ' (exported report)' };
  }
  const data = resolve(target, 'data');
  const dataStore = basename(target) === '.repometry' && await isDirectory(data);
  const directStore = await isDirectory(resolve(target, 'commits'));
  if (!repository && !dataStore && !directStore && storeOption === undefined) {
    throw new Error(`No report at ${target}: expected a repository, a .repometry folder or an exported report`);
  }
  const root = repository ?? target;
  const store = selectStore(root, storeOption ?? (dataStore ? data : directStore ? target : undefined), invocationDirectory(input));
  if ((await store.reader.listSummaries?.() ?? []).length === 0) throw new Error(`No saved inspections in ${store.path ?? storeOption}. Run repometry analyze first.`);
  const [pulls, config] = await Promise.all([store.path ? listPullReviews(store.path) : [], readConfig(root, input)]);
  const local = repository ? readLocalSources(repository) : undefined;
  const server = await serveSite(store.reader, port, { languages: reportLanguages(config), title: input.text('title') ?? basename(root), components: config.components, pulls,
    branch: input.text('branch') ?? config.branch, readCommitMetadata: repository ? commitMetadataReader(repository) : undefined,
    sources: local ? resolveSourceLocator('local', { remotes: [], env: {} }) : undefined }, local);
  return { ...server, label: `${basename(root)} (live from ${store.path ?? storeOption})` };
}
