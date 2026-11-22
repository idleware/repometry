#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gitRoot, resolveGitCommit } from '../api/git/git.js';
import { resolveGitBranch } from '../api/git/commit-metadata.js';
import { clearSourceCache, sourceCacheRoot } from '../api/git/source-cache.js';
import { writeGitHubDiffCoverage, writeGitHubResult, writeGitHubReview } from '../api/gh/github.js';
import { remoteExecutor } from '../api/worker/remote-executor.js';
import { serveWorker } from '../api/worker/worker.js';
import { workerToken } from '../api/worker/worker-protocol.js';
import { analyzeSnapshot, attachFindings, inspect } from '../compose/inspect.js';
import { measureDiffCoverage } from '../compose/diff-coverage.js';
import { prepareMetabranch } from '../compose/prepare-metabranch.js';
import { reviewExitCode, reviewPull } from '../compose/review.js';
import { builtInPlugins } from '../compose/plugin-list.js';
import { isRecord } from '../core/engine/plugin.js';
import { validSubjectId } from '../core/model/report.js';
import type { Report } from '../core/model/report.js';
import { sourceExclusionMatcher } from '../core/profile/exclusions.js';
import { compareInspections } from '../core/usecases/compare.js';
import { exportProjects } from '../report/html/site/projects.js';
import { fileMetrics } from '../report/json/projections/file-metrics.js';
import { savePullReview } from '../report/json/store/pull-review-store.js';
import type { ReportReader } from '../report/json/validation/report.js';
import { dispatch, flag, option } from './arguments.js';
import type { Command, Invocation } from './arguments.js';
import { readConfig } from './config.js';
import { importerIds, readInputs } from './imports.js';
import { outputReports, reporterIds, viewTarget } from './reporting.js';
import { findRepository, selectStore, writableStore } from './store.js';

const configOptions = { config: option('FILE', 'Read a different JSON configuration.'), 'no-config': flag('Skip configuration.') };
const importOption = option('FORMAT=PATH', 'Import a report produced by another tool. Repeatable.', { multiple: true });
const excludeOption = option('PATTERN', 'Exclude a path or glob. Repeatable.', { multiple: true });
const ciOption = option('PROVIDER', 'Send CI output to github or none.');
const outputOption = option('PATH', 'Set the report output path.', { short: 'o' });
const baselineOption = option('PATH|git:REF', 'Select the baseline report store.');
const branchOption = option('NAME', 'Name the branch represented by the report.');
const renderOptions = {
  output: outputOption, mode: option('public|private', 'Select the report data to expose.'),
  sources: option('auto|none|ID[:SPEC]', 'Select source navigation for a private report.'),
  title: option('NAME', 'Set the report title.'), components: option('FILE', 'Read component definitions.'),
  'no-footer': flag('Omit the footer.'), branch: branchOption,
};

const commands: Readonly<Record<string, Command>> = {
  analyze: {
    description: 'Analyze and save one revision.', parameters: '[REVISION]', max: 1,
    options: { ...configOptions, ...renderOptions, 'working-tree': flag('Analyze the working directory.'),
      import: importOption, report: option('FORMAT[=PATH]', 'Generate a report after inspection. Repeatable.', { multiple: true }),
      exclude: excludeOption, 'import-root': option('DIR', 'Resolve scanner locations relative to this directory.'),
      worker: option('URL', 'Run analysis on a Repometry worker.'), ci: ciOption },
    run: analyze,
  },
  show: {
    description: 'Print a saved report.', parameters: 'REVISION|DIGEST', min: 1, max: 1,
    options: { files: flag('Print file metrics.') }, run: show,
  },
  history: { description: 'List saved inspections.', async run(input) {
    const { store } = await context(input);
    print({ schema: 'urn:repometry:schema:inspection-history:1', inspections: (await store.reader.list()).map(inspectionSummary) });
  } },
  compare: {
    description: 'Compare two saved reports.', parameters: 'BASE [HEAD]', min: 1, max: 2,
    options: { 'baseline-store': baselineOption }, run: compare,
  },
  'diff-coverage': {
    description: 'Measure coverage of added lines.', parameters: 'BASE [HEAD]', min: 1, max: 2,
    options: { ...configOptions, import: importOption, exclude: excludeOption, ci: ciOption,
      'min-coverage': option('PERCENT', 'Minimum acceptable changed-line coverage.') }, run: diffCoverage,
  },
  review: {
    description: 'Review coverage and issues introduced by a change.', parameters: 'BASE [HEAD]', min: 1, max: 2,
    options: { ...configOptions, import: importOption, exclude: excludeOption, ci: ciOption,
      'baseline-store': baselineOption, pull: option('NUMBER', 'Store a review for this pull request.'),
      'min-coverage': option('PERCENT', 'Minimum acceptable changed-line coverage.'),
      'min-lines': option('COUNT', 'Minimum measured lines for the changed-line coverage gate.'),
      'max-coverage-drop': option('POINTS', 'Maximum total coverage drop.'),
      'max-new-issues': option('COUNT', 'Maximum count of new quality findings.'),
      annotations: flag('Write GitHub line annotations.') }, run: review,
  },
  report: {
    description: 'Render HTML or JSON from saved reports.', parameters: '[FORMAT[=PATH]]...', max: Infinity,
    options: { ...configOptions, ...renderOptions }, async run(input) {
      const { root, store } = await context(input);
      const config = await readConfig(root, input);
      const requests = input.args.length ? input.args : config.reports.length ? config.reports : ['html'];
      print({ schema: 'urn:repometry:schema:render-result:1', reports: await outputReports(root, store, requests, input, config) });
    },
  },
  view: {
    description: 'Open a repository, store or exported site locally.', parameters: '[TARGET]', max: 1,
    options: { ...configOptions, branch: branchOption, port: option('PORT', 'Listen on this localhost port.'), title: renderOptions.title,
      components: renderOptions.components, 'no-footer': renderOptions['no-footer'] },
    async run(input) { announce(await viewTarget(input, port(input.text('port') ?? '0'))); },
  },
  projects: {
    description: 'Generate a projects index.', options: { output: outputOption, 'no-footer': renderOptions['no-footer'] },
    async run(input) {
      const destination = resolve(input.text('repo') ?? '.', input.text('output') ?? '.');
      print({ schema: 'urn:repometry:schema:projects-result:1', destination,
        projects: await exportProjects(destination, { footer: !input.flag('no-footer') }) });
    },
  },
  prepare: {
    description: 'Prepare a report for a Git storage branch.', parameters: 'REVISION', min: 1, max: 1,
    options: { worktree: option('DIR', 'Select the storage worktree.'), branch: option('NAME', 'Select the storage branch.') },
    async run(input) {
      const { root, store } = await context(input);
      const path = input.text('worktree');
      if (!path) throw new Error('prepare requires --worktree');
      const worktree = resolve(root, path);
      const id = await commitId(root, input.args[0]!);
      const report = await store.reader.read({ kind: 'commit', id });
      const files = await prepareMetabranch({ repository: root, worktree, branch: input.text('branch') ?? 'repometry', report });
      print({ schema: 'urn:repometry:schema:prepare-result:1', subject: report.subject, worktree, files });
    },
  },
  plugins: { description: 'List plugins and supported formats.', run() {
    print({ schema: 'urn:repometry:schema:plugin-list:1', plugins: builtInPlugins, importers: importerIds,
      reporters: reporterIds, ci: ['github'], stores: ['local', 'git'] });
  } },
  cache: {
    description: 'Find or clear the system cache.', parameters: 'path|clear', min: 1, max: 1,
    options: { sources: flag('Clear only source blobs.') },
    async run(input) {
      const action = input.args[0];
      if (action !== 'path' && action !== 'clear') throw new Error('Use cache path or cache clear');
      if (action === 'path' && input.flag('sources')) throw new Error('--sources requires cache clear');
      const path = sourceCacheRoot();
      if (action === 'clear') await clearSourceCache(path);
      print({ schema: 'urn:repometry:schema:cache-result:1', path, ...(action === 'clear' ? { cleared: ['sources'] } : {}) });
    },
  },
  worker: { description: 'Run the remote analysis worker.',
    options: { port: option('PORT', 'Listen on this port.'), listen: option('ADDRESS', 'Listen on 127.0.0.1 or 0.0.0.0.') },
    async run(input) {
      const host = input.text('listen') ?? '127.0.0.1';
      if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('--listen must be 127.0.0.1 or 0.0.0.0');
      announce(await serveWorker(host, port(input.text('port') ?? '7331'), workerToken(), analyzeSnapshot));
    } },
};

async function context(input: Invocation) {
  const directory = resolve(input.text('repo') ?? '.');
  const root = await findRepository(directory) ?? directory;
  return { directory, root, store: selectStore(root, input.text('store')) };
}

async function analyze(input: Invocation): Promise<number> {
  const { directory, root, store } = await context(input);
  const output = writableStore(store);
  if (input.flag('working-tree') && input.args.length) throw new Error('Choose a revision or --working-tree');
  const github = useGitHub(input);
  const config = await readConfig(root, input);
  const branch = input.text('branch') ?? config.branch;
  const revision = input.args[0] ?? (!input.flag('working-tree') && branch !== undefined ? await resolveGitBranch(root, branch) : 'HEAD');
  const imports = input.many('import');
  const { lcov, findings } = readInputs(root, imports.length ? imports : config.imports);
  const importRoot = input.text('import-root');
  if (importRoot && findings.length === 0) throw new Error('--import-root requires a scanner report');
  const worker = input.text('worker');
  const report = await inspect({ directory, output, source: input.flag('working-tree') ? { workingTree: true } : { revision },
    lcov, exclude: [...config.exclude, ...input.many('exclude')], ignore: config.ignore,
    findingInputs: findings, findingRoot: importRoot ? resolve(root, importRoot) : undefined },
  worker === undefined ? undefined : remoteExecutor(worker, workerToken()));
  if (github) await writeGitHubResult(report);
  const requested = input.many('report');
  const reports = await outputReports(root, store, requested.length ? requested : config.reports, input, config);
  print({ schema: 'urn:repometry:schema:analysis-result:1', ...inspectionSummary(report), store: output, reports });
  return report.status === 'partial' ? 2 : 0;
}

async function show(input: Invocation) {
  const { root, store } = await context(input);
  const ref = input.args[0]!;
  const id = await commitId(root, ref);
  let report: Report;
  try {
    report = await store.reader.read({ kind: 'commit', id });
  } catch (error) {
    if (!validSubjectId('working-tree', ref) || store.path === undefined || !(error instanceof Error)
      || !('code' in error) || error.code !== 'ENOENT') throw error;
    report = await store.reader.read({ kind: 'working-tree', id: ref });
  }
  print(input.flag('files') ? fileMetrics(report) : report);
}

async function compare(input: Invocation) {
  const { root, store } = await context(input);
  const baselinePath = input.text('baseline-store');
  const baseline = baselinePath === undefined ? store : selectStore(root, baselinePath);
  const [base, head] = await Promise.all([commitId(root, input.args[0]!), commitId(root, input.args[1] ?? 'HEAD')]);
  const current = store.reader.read({ kind: 'commit', id: head });
  const before = base === head && baseline === store ? current : baseline.reader.read({ kind: 'commit', id: base });
  print(compareInspections(await before, await current));
}

async function diffCoverage(input: Invocation): Promise<number> {
  const { root } = await context(input);
  const config = await readConfig(root, input);
  const imports = input.many('import');
  const { lcov, findings } = readInputs(root, imports.length ? imports : config.imports);
  if (!lcov || (imports.length && findings.length)) throw new Error('diff-coverage requires --import lcov=PATH');
  const report = await measureDiffCoverage({ directory: root, base: input.args[0]!, revision: input.args[1] ?? 'HEAD', lcov,
    exclude: [...config.exclude, ...input.many('exclude')], minimumPercent: percent(input.text('min-coverage') ?? config.minCoverage, '--min-coverage') });
  if (useGitHub(input)) await writeGitHubDiffCoverage(report);
  print(report);
  return report.status === 'partial' ? 2 : report.decision?.status === 'failed' ? 3 : 0;
}

async function review(input: Invocation): Promise<number> {
  const { root, store } = await context(input);
  const github = useGitHub(input);
  if (input.flag('annotations') && !github) throw new Error('--annotations requires --ci github');
  const config = await readConfig(root, input);
  const imports = input.many('import');
  const { lcov, findings } = readInputs(root, imports.length ? imports : config.imports);
  const baselinePath = input.text('baseline-store');
  const baseline = baselinePath === undefined ? store : selectStore(root, baselinePath);
  const exclude = [...config.exclude, ...input.many('exclude')];
  const current: ReportReader = imports.length && findings.length ? {
    list: () => store.reader.list(),
    read: async subject => {
      const report = await store.reader.read(subject);
      const source = report.appliedConfig.source;
      const generated = isRecord(source) && Array.isArray(source.generatedExcluded)
        ? source.generatedExcluded.filter((path): path is string => typeof path === 'string') : [];
      return attachFindings(report, findings, root, root, sourceExclusionMatcher(exclude, generated));
    },
  } : store.reader;
  const number = count(input.text('pull'), '--pull', 1);
  const report = await reviewPull({ directory: root, base: input.args[0]!, revision: input.args[1] ?? 'HEAD', lcov, exclude, number,
    minimumPercent: percent(input.text('min-coverage') ?? config.minCoverage, '--min-coverage'),
    minimumLines: count(input.text('min-lines') ?? config.minLines, '--min-lines'),
    maxCoverageDrop: percent(input.text('max-coverage-drop') ?? config.maxCoverageDrop, '--max-coverage-drop'),
    maxNewIssues: count(input.text('max-new-issues') ?? config.maxNewIssues, '--max-new-issues') }, current, baseline.reader);
  if (number !== undefined) await savePullReview(writableStore(store), report);
  if (github) await writeGitHubReview(report, input.flag('annotations') ? await gitRoot(root) : undefined);
  print(report);
  return reviewExitCode(report);
}

function commitId(root: string, revision: string): Promise<string> {
  return validSubjectId('commit', revision) ? Promise.resolve(revision) : resolveGitCommit(root, revision);
}

function useGitHub(input: Invocation): boolean {
  const provider = input.text('ci') ?? 'none';
  if (provider !== 'none' && provider !== 'github') throw new Error('--ci must be github or none');
  return provider === 'github';
}

function percent(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || number < 0 || number > 100) throw new Error(`${name} must be a percentage from 0 to 100`);
  return number;
}

function count(value: string | undefined, name: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return number;
}

function port(value: string): number {
  const number = count(value, '--port')!;
  if (number > 65535) throw new Error('--port must be an integer from 0 to 65535');
  return number;
}

function announce(server: { url: string; close: () => void; label?: string }): void {
  process.once('SIGINT', () => { process.exitCode = 130; server.close(); });
  process.once('SIGTERM', server.close);
  process.stderr.write(`Serving${server.label ? ' ' + server.label : ''} at ${server.url}\n`);
}

function inspectionSummary(report: Report) {
  return { subject: report.subject, generatedAt: report.generatedAt, status: report.status, scope: report.scope,
    measurements: report.measurements.length, diagnostics: report.diagnostics.length };
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

try {
  const manifest = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string };
  process.exitCode = await dispatch(commands, process.argv.slice(2), manifest.version);
} catch (error) {
  process.stderr.write(`repometry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
