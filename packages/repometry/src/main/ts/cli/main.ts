#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { firstParentRange, gitRoot, resolveGitCommit } from '../api/git/git.js';
import { gitReportObjects } from '../api/git/git-reader.js';
import { cacheRoot, clearCaches } from '../api/cache/root.js';
import { gitHubPullRequest, writeGitHubReview } from '../api/gh/github.js';
import { defaultLanguages } from '../compose/languages.js';
import { attachFindings, inspect } from '../compose/inspect.js';
import { review as reviewChange, reviewExitCode, reviewReason } from '../compose/review.js';
import { effectivePlugins } from '../compose/plugin-list.js';
import { validSubjectId } from '@repometry/core/internal/model/report.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import { exportProjects } from '../report/html/site/projects.js';
import { fileMetrics } from '../report/json/projections/file-metrics.js';
import { pullReviewMarkdown } from '../report/markdown/pull-review.js';
import { LocalObjectStore } from '../report/json/store/object-store.js';
import { checkStore } from '../report/json/store/store-check.js';
import type { ReportReader } from '../report/json/validation/report.js';
import { dispatch, flag, option } from './arguments.js';
import type { Command, Invocation } from './arguments.js';
import { configFile, listOption, loadConfig, readConfig, readConfigValue, readDisplayConfig } from './config.js';
import { analyzeCommits, isSaved } from './range-jobs.js';
import { importerIds, readInputs } from './imports.js';
import { outputReports, reporterIds, viewTarget } from './reporting.js';
import { parseRange } from './revisions.js';
import type { RevisionRange } from './revisions.js';
import { findRepository, invocationDirectory, selectStore, writableStore } from './store.js';

const configOptions = { config: option('FILE', 'Read a different JSON configuration.'), 'no-config': flag('Skip configuration.') };
const importOption = option('FORMAT=PATH', 'Import a report produced by another tool. Repeatable.', { multiple: true });
const excludeOption = option('PATTERN', 'Exclude a path or glob. Repeatable.', { multiple: true });
const ciOption = option('PROVIDER', 'Send CI output to github or none.');
const repoOption = option('DIR', 'Run in the given repository.', { short: 'C' });
const storeOption = option('PATH|git:REF', 'Select a report store.');
const storageOptions = { repo: repoOption, store: storeOption };
const displayOptions = {
  ...configOptions, branch: option('NAME', 'Name the branch shown in the report.'), title: option('NAME', 'Set the report title.'),
};

const commands: Readonly<Record<string, Command>> = {
  analyze: {
    description: 'Analyze and save one revision or a range of commits.', parameters: '[REVISION | BASE..[HEAD]]', max: 1,
    options: { ...configOptions, ...storageOptions, 'working-tree': flag('Analyze the working directory.'),
      'skip-saved': flag('Keep commits that already have a saved inspection.'),
      concurrency: option('N', 'Maximum local analysis workers for a range. Defaults to the available cores.'),
      import: importOption,
      exclude: excludeOption, 'import-root': option('DIR', 'Resolve scanner locations relative to this directory.') },
    run: runAnalysis,
  },
  show: {
    description: 'Print a saved report.', parameters: 'REVISION|DIGEST', min: 1, max: 1,
    options: { ...storageOptions, files: flag('Print file metrics.') }, run: show,
  },
  history: { description: 'List saved inspections.', options: storageOptions, async run(input) {
    const { store } = await context(input);
    print({ schema: 'urn:repometry:schema:inspection-history:1', inspections: (await store.reader.list()).map(inspectionSummary) });
  } },
  review: {
    description: 'Report the issues a change adds or makes worse on the lines it changes.', parameters: 'BASE [HEAD]', min: 1, max: 2,
    options: { ...configOptions, repo: repoOption, import: importOption, exclude: excludeOption, ci: ciOption,
      pull: option('NUMBER', 'Name the pull request in the result.'),
      markdown: option('PATH', 'Also write the result as Markdown, for a pull request comment.') }, run: review,
  },
  report: {
    description: 'Render HTML or JSON from saved reports.', parameters: '[FORMAT[=PATH]]...', max: Infinity,
    options: { ...displayOptions, ...storageOptions, source: option('auto|none|ID[:SPEC]', 'Select where the report reads source files.') },
    async run(input) {
      const { root, store } = await context(input);
      const config = await readDisplayConfig(root, input);
      print({ schema: 'urn:repometry:schema:render-result:1', reports: await outputReports(root, store, input, config) });
    },
  },
  view: {
    description: 'Open a repository, store or exported site locally.', parameters: '[TARGET]', max: 1,
    options: { ...displayOptions, store: storeOption, port: option('PORT', 'Listen on this localhost port.') },
    async run(input) { announce(await viewTarget(input, port(input.text('port') ?? '0'))); },
  },
  projects: {
    description: 'Generate a projects index.', parameters: '[DIR]', max: 1,
    async run(input) {
      const destination = resolve(input.args[0] ?? '.');
      print({ schema: 'urn:repometry:schema:projects-result:1', destination, projects: await exportProjects(destination) });
    },
  },
  plugins: { description: 'List effective plugins and supported formats.', options: { ...configOptions, repo: repoOption },
    async run(input) {
      const { root } = await repositoryContext(input);
      const config = await readConfig(root, input, true);
      print({ schema: 'urn:repometry:schema:plugin-list:2', plugins: effectivePlugins(config.plugins, config.parsers),
        importers: importerIds, reporters: reporterIds, ci: ['github'], stores: ['local', 'git'] });
    },
  },
  cache: {
    description: 'Find or clear the system cache.', parameters: 'path|clear', min: 1, max: 1,
    async run(input) {
      const action = input.args[0];
      if (action !== 'path' && action !== 'clear') throw new Error('Use cache path or cache clear');
      const path = cacheRoot();
      const cleared = action === 'clear' ? await clearCaches(path) : undefined;
      print({ schema: 'urn:repometry:schema:cache-result:1', path, cleared });
    },
  },
  store: {
    description: 'Check saved inspections and repair what can be restored.', parameters: 'check', min: 1, max: 1,
    options: {
      ...storageOptions, repair: flag('Restore missing data from a copy.'),
      from: option('PATH|git:REF', 'The copy: another store or a storage branch.'),
    },
    async run(input) {
      if (input.args[0] !== 'check') throw new Error('Use store check');
      const from = input.text('from');
      if (from !== undefined && !input.flag('repair')) throw new Error('--from requires --repair');
      const { directory, root, store } = await context(input);
      const path = writableStore(store);
      const source = from === undefined ? undefined
        : from.startsWith('git:') ? await gitReportObjects(root, from.slice(4)) : new LocalObjectStore(resolve(directory, from)).source();
      const result = await checkStore(path, input.flag('repair') ? { from: source } : undefined);
      print({ ...result, store: path });
      return result.problems.length ? 3 : 0;
    },
  },
};

async function repositoryContext(input: Invocation) {
  const directory = invocationDirectory(input);
  const root = await findRepository(directory) ?? directory;
  return { directory, root };
}

async function context(input: Invocation) {
  const { directory, root } = await repositoryContext(input);
  return { directory, root, store: selectStore(root, input.text('store'), directory) };
}

function runAnalysis(input: Invocation): Promise<number> {
  const range = input.args[0] === undefined ? undefined : parseRange(input.args[0]);
  if (range) return analyzeRange(input, range);
  if (input.text('concurrency') !== undefined) throw new Error('--concurrency requires a revision range');
  return analyze(input);
}

async function analyze(input: Invocation): Promise<number> {
  const { directory, root, store } = await context(input);
  const output = writableStore(store);
  const workingTree = input.flag('working-tree');
  if (workingTree && input.args.length) throw new Error('Choose a revision or --working-tree');
  if (workingTree && input.flag('skip-saved')) throw new Error('--skip-saved applies to commits, not --working-tree');
  const config = await readConfig(root, input);
  const revision = input.args[0] ?? 'HEAD';
  const imports = input.many('import');
  const { findings, ...coverage } = imports.length ? readInputs(directory, imports) : readInputs(root, config.imports);
  const importRoot = input.text('import-root');
  if (importRoot && findings.length === 0) throw new Error('--import-root requires a scanner report');
  const savedId = input.flag('skip-saved') ? await resolveGitCommit(root, revision) : undefined;
  const skipped = savedId !== undefined && await isSaved(output, savedId);
  const report = skipped ? await store.reader.read({ kind: 'commit', id: savedId })
    : await inspect({ directory, output, source: workingTree ? { workingTree: true } : { revision },
      ...coverage, exclude: listOption(input, 'exclude', config.exclude), ignore: config.ignore, plugins: config.plugins, parsers: config.parsers,
      findingInputs: findings, findingRoot: importRoot ? resolve(directory, importRoot) : undefined });
  print({ schema: 'urn:repometry:schema:analysis-result:1', ...inspectionSummary(report), ...(skipped ? { skipped: true } : {}),
    store: output });
  return report.status === 'partial' ? 2 : 0;
}

async function analyzeRange(input: Invocation, range: RevisionRange): Promise<number> {
  const { directory, root, store } = await context(input);
  const output = writableStore(store);
  if (input.flag('working-tree')) throw new Error('Choose a range or --working-tree');
  if (input.many('import').length) throw new Error('--import describes one checkout and cannot be used with a range');
  if (input.text('import-root')) throw new Error('--import-root requires a scanner report');
  const concurrency = count(input.text('concurrency'), '--concurrency', 1);
  const configValue = await readConfigValue(root, input);
  const settingsFile = configFile(root, input);
  const config = await loadConfig(configValue, root, settingsFile);
  if (config.imports.length) process.stderr.write('Imports from the config describe one checkout and are skipped for a range.\n');
  const { base, head, commits } = await firstParentRange(root, range.base, range.head);
  if (!commits.length) process.stderr.write(`No commits in ${range.base}..${range.head}.\n`);
  const inspection = { directory, output, exclude: listOption(input, 'exclude', config.exclude) };
  const { interrupted, ...results } = await analyzeCommits(commits, {
    inspection, config, configuration: { value: configValue, root, file: settingsFile }, concurrency, skipSaved: input.flag('skip-saved'),
  });
  print({ schema: 'urn:repometry:schema:analyze-range:1', range: `${base}..${head}`,
    ...results, store: output });
  return interrupted ? 130 : results.failed.length || results.partial.length ? 2 : 0;
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
  print(input.flag('files') ? fileMetrics(report, defaultLanguages) : report);
}

async function review(input: Invocation): Promise<number> {
  const { directory, root } = await repositoryContext(input);
  const github = useGitHub(input);
  const config = await readConfig(root, input);
  const imports = input.many('import');
  const { findings, ...coverage } = imports.length ? readInputs(directory, imports) : readInputs(root, config.imports);
  if (findings.length && imports.length) throw new Error('review compares both sides of a change; scanner imports apply to full inspections only');
  if (findings.length) process.stderr.write('Scanner imports from the config are skipped: review compares both sides of a change.\n');
  const profileFile = configFile(root, input);
  const { plugins, ...profile } = config;
  const report = await reviewChange({ directory: root, base: input.args[0]!, revision: input.args[1] ?? 'HEAD', ...coverage,
    exclude: listOption(input, 'exclude', config.exclude), ignore: config.ignore, plugins, parsers: config.parsers, profile,
    profilePath: profileFile === undefined ? undefined : relative(root, profileFile).split(sep).join('/'),
    number: count(input.text('pull'), '--pull', 1) ?? (github ? await gitHubPullRequest() : undefined),
    minimumPercent: config.minCoverage, minimumLines: config.minLines, maxNewIssues: config.maxNewIssues });
  const markdown = pullReviewMarkdown(report);
  if (github) await writeGitHubReview(report, markdown, await gitRoot(root));
  const markdownPath = input.text('markdown');
  if (markdownPath !== undefined) await writeFile(resolve(directory, markdownPath), markdown);
  print(report);
  const code = reviewExitCode(report);
  if (code !== 0) process.stderr.write(`${reviewReason(report)}\n`);
  return code;
}

function commitId(root: string, revision: string): Promise<string> {
  return validSubjectId('commit', revision) ? Promise.resolve(revision) : resolveGitCommit(root, revision);
}

function useGitHub(input: Invocation): boolean {
  const provider = input.text('ci') ?? 'none';
  if (provider !== 'none' && provider !== 'github') throw new Error('--ci must be github or none');
  return provider === 'github';
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
