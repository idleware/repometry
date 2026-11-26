import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';
import { Ajv2020 } from 'ajv/dist/2020.js';
import metricCatalog from '../../main/resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import inspectionV1 from '../../main/resources/report/json/viewer-inspection-v1.schema.json' with { type: 'json' };
import summaryV1 from '../../main/resources/report/json/repository-summary-v1.schema.json' with { type: 'json' };
import compactV1 from '../../main/resources/report/json/compact-json-v1.schema.json' with { type: 'json' };
import fileMetricsV1 from '../../main/resources/report/json/file-metrics-v1.schema.json' with { type: 'json' };
import reportV2 from '../../main/resources/report/json/report-v2.schema.json' with { type: 'json' };
import { definitions } from '../../main/ts/core/model/measurement.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import { defaultSourceExclusions, generatedSourcePolicy } from '../../main/ts/core/profile/exclusions.js';
import { reportSchema } from '../../main/ts/report/json/validation/report.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import { unpackJson } from '../../main/ts/report/json/wire/compact-json.js';
import type { RepositorySummary } from '../../main/ts/report/json/wire/summary-model.js';
import type { InspectionAsset } from '../../main/ts/report/json/wire/inspection-details-model.js';

const cli = resolve('target/main/ts/cli/main.js');

test('local profile ignores findings without dropping their evidence or modifying source metrics', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-ignore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.repometry'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'adapter.js'), 'export const adapter = (a,b,c,d,e,f) => [a,b,c,d,e,f];\n');
  const ignore = [{ path: 'src/**', tool: 'repometry', rule: 'function-parameters', reason: 'Existing interface' }];
  await writeFile(join(dir, 'repometry.config.json'), JSON.stringify({ ignore }));
  const scan = invoke(dir, ['analyze', '--working-tree']);
  assert.equal(scan.status, 0, scan.stderr);
  const id = JSON.parse(scan.stdout).subject.id as string;
  const read = () => JSON.parse(invoke(dir, ['show', id]).stdout) as Report;
  const filtered = read();
  assert.deepEqual(filtered.appliedConfig.findingIgnore, ignore);
  assert.deepEqual(filtered.findings, []);
  assert.equal(filtered.ignoredFindings?.[0]?.matchedRule, 0);
  assert.equal(filtered.ignoredFindings?.[0]?.finding.rule, 'function-parameters');
  assert.equal(qualitySummary(filtered).maintainability?.effortMinutes, 0);
  const unfiltered = invoke(dir, ['analyze', '--working-tree', '--no-config']);
  assert.equal(unfiltered.status, 0, unfiltered.stderr);
  const original = read();
  assert.equal(original.findings?.[0]?.rule, 'function-parameters');
  assert.equal(original.ignoredFindings, undefined);
  assert.ok((qualitySummary(original).maintainability?.effortMinutes ?? 0) > 0);
  assert.deepEqual(filtered.measurements, original.measurements);
});

test('packaged entry point saves and reads an inspection and atomically replaces its applied config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), 'export function pick(flag: boolean) {\n  function nested(x: boolean) { return x ? 1 : 0; }\n  return flag && <span>{nested(flag)}</span>;\n}\n');
  await writeFile(join(dir, 'unit.info'), 'SF:index.tsx\nDA:2,0\nDA:3,8\nend_of_record');
  await writeFile(join(dir, 'integration.info'), 'SF:index.tsx\nDA:2,1\nend_of_record\n');

  const first = invoke(dir, ['analyze', '--working-tree', '--import', 'lcov=unit.info', '--import', 'lcov=integration.info']);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout) as Pick<Report, 'subject' | 'scope'>;
  assert.deepEqual(summary.scope, { files: 1, parsed: 1 });
  const id = summary.subject.id;
  const result = invoke(dir, ['show', id]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Report;
  assert.equal(report.schema, reportSchema);
  const complexity = report.measurements.filter(item => item.definition === definitions.complexity);
  assert.deepEqual(complexity.map(item => [item.name, item.value]).sort(), [['pick', 2], ['pick.nested', 2]]);
  const coverage = report.measurements.find(item => item.definition === definitions.coverage && item.target === 'repository');
  assert.deepEqual(coverage, { definition: definitions.coverage, target: 'repository', covered: 2, total: 2, value: 1 });
  const coverageInput = report.appliedConfig.coverage as { inputDigest: string; inputDigests: string[] };
  assert.equal(coverageInput.inputDigests.length, 2);
  assert.ok(coverageInput.inputDigests.every(digest => /^[a-f0-9]{64}$/.test(digest)));
  const reverse = invoke(dir, ['analyze', '--working-tree', '--import', 'lcov=integration.info', '--import', 'lcov=unit.info']);
  assert.equal(reverse.status, 0, reverse.stderr);
  const reversed = JSON.parse(invoke(dir, ['show', id]).stdout) as Report;
  assert.deepEqual(reversed.appliedConfig.coverage, coverageInput);

  const second = invoke(dir, ['analyze', '--working-tree']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).subject.id, id);
  const replaced = JSON.parse(invoke(dir, ['show', id]).stdout) as Report;
  assert.equal(replaced.appliedConfig.coverage, null);
  assert.ok(replaced.measurements.every(item => item.definition !== definitions.coverage));
  assert.equal(JSON.parse(invoke(dir, ['history']).stdout).inspections.length, 1);

  const saved = join(dir, '.repometry', 'working-trees', id, 'report.json');
  await writeFile(saved, JSON.stringify({ ...replaced, schema: 'urn:repometry:schema:report:999' }));
  const invalid = invoke(dir, ['show', id]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported or missing report schema/);
});

test('individual parse failures and unmapped LCOV files are visible in a saved partial report', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-partial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'ok.mjs'), 'export function f() { return true; }\n');
  await writeFile(join(dir, 'broken.ts'), 'export function invalid( {');
  await writeFile(join(dir, 'coverage.info'), 'SF:missing.js\nDA:10,1\nend_of_record\nSF:ok.mjs\nDA:10,1\nend_of_record\n');

  const result = invoke(dir, ['analyze', '--working-tree', '--import', 'lcov=coverage.info']);
  assert.equal(result.status, 2, result.stderr);
  const id = JSON.parse(result.stdout).subject.id as string;
  const report = JSON.parse(invoke(dir, ['show', id]).stdout) as Report;
  assert.deepEqual(report.scope, { files: 2, parsed: 1 });
  assert.ok(report.measurements.some(item => item.path === 'ok.mjs'));
  assert.ok(report.diagnostics.some(item => item.path === 'broken.ts' && item.state === 'failed'));
  assert.ok(report.diagnostics.some(item => item.path === 'broken.ts' && item.state === 'blocked'));
  assert.ok(report.diagnostics.some(item => item.path === 'missing.js' && item.state === 'partial'));
  assert.ok(report.diagnostics.some(item => item.path === 'ok.mjs' && item.state === 'partial'));
  assert.equal(report.measurements.find(item => item.definition === definitions.coverage)?.value, null);
});

test('typed exclusions replace configured exclusions and apply to source files and LCOV', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ['.yarn/releases', '.yarn-tools', 'packages/app/vendor']) {
    await mkdir(join(dir, path), { recursive: true });
  }
  const included = '.yarn-tools/helper.js';
  const configuredOnly = 'profile-only.js';
  const excluded = ['.yarn/releases/yarn.cjs', 'packages/app/vendor/runtime.js', 'extra bundle.js'];
  await writeFile(join(dir, included), 'export function helper() { return 1; }\n');
  for (const path of excluded) await writeFile(join(dir, path), 'export function invalid( {\n');
  await writeFile(join(dir, configuredOnly), 'export const kept = true;\n');
  await writeFile(join(dir, 'profile.json'), JSON.stringify({ exclude: ['./.yarn/releases/', '**/vendor', 'extra bundle.js', configuredOnly] }));
  await writeFile(join(dir, 'coverage.info'), [
    `SF:${included}\nDA:1,1\nend_of_record\n`,
    ...excluded.map(path => `SF:${path}\nDA:999,0\nend_of_record\n`),
  ].join(''));

  const configured = invoke(dir, ['analyze', '--working-tree', '--config', 'profile.json']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout).scope, { files: 1, parsed: 1 });
  const result = invoke(dir, ['analyze', '--working-tree', '--config', 'profile.json',
    '--exclude', '.yarn/releases', '--exclude', '**/vendor', '--exclude', 'extra bundle.js', '--import', 'lcov=coverage.info']);
  assert.equal(result.status, 0, result.stderr);
  const { subject } = JSON.parse(result.stdout) as Pick<Report, 'subject'>;
  const report = JSON.parse(invoke(dir, ['show', subject.id]).stdout) as Report;
  assert.deepEqual(report.scope, { files: 2, parsed: 2 });
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.appliedConfig.source, {
    extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.go', '.py'],
    excludedDirectories: ['.git', '.repometry', 'node_modules', 'target'],
    excludedOutput: '.repometry',
    excludedPaths: ['.yarn/releases', '**/vendor', 'extra bundle.js'],
    defaultExclusions: defaultSourceExclusions,
    generatedSourcePolicy,
    generatedExcluded: [],
  });
  assert.deepEqual([...new Set(report.measurements.flatMap(row => row.path === undefined ? [] : [row.path]))], [included, configuredOnly]);
  assert.deepEqual(report.measurements.find(row => row.definition === definitions.coverage && row.target === 'repository'),
    { definition: definitions.coverage, target: 'repository', covered: 1, total: 1, value: 1 });

  const allExcluded = invoke(dir, ['analyze', '--working-tree', '--config', 'profile.json',
    '--exclude', 'extra bundle.js', '--exclude', included, '--exclude', configuredOnly, '--import', 'lcov=coverage.info']);
  assert.equal(allExcluded.status, 0, allExcluded.stderr);
  const securityOnly = JSON.parse(allExcluded.stdout) as Pick<Report, 'scope' | 'status'>;
  assert.deepEqual(securityOnly.scope, { files: 0, parsed: 0 });
  assert.equal(securityOnly.status, 'complete');

  const empty = invoke(dir, ['analyze', '--working-tree', '--config', 'profile.json',
    '--exclude', 'extra bundle.js', '--exclude', included, '--exclude', configuredOnly, '--exclude', 'profile.json', '--exclude', 'coverage.info']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, 'not-applicable');

  const invalid = invoke(dir, ['analyze', '--working-tree', '--exclude', '../vendor']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid source exclusion/);
});

test('default vendor and generated-source exclusions also filter LCOV', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-default-exclusions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const excluded = { '.yarn/releases/yarn.cjs': 'unparseable(', '.pnp.cjs': 'unparseable(', 'third_party/lib.ts': 'unparseable(',
    'packages/app/vendor/runtime.js': 'unparseable(', 'runtime.min.js': 'unparseable(', 'runtime.bundle.js': 'unparseable(',
    'packages/app/runtime-bundle.cjs': 'unparseable(',
    'dense.js': `export const dense = "${'x'.repeat(1200)}";`,
    'mapped.js': 'export const mapped = 1;\n//# sourceMappingURL=mapped.js.map\n' };
  for (const path of ['.yarn/releases', 'third_party', 'packages/app/vendor']) await mkdir(join(dir, path), { recursive: true });
  await Promise.all(Object.entries(excluded).map(([path, content]) => writeFile(join(dir, path), content)));
  await writeFile(join(dir, 'index.js'), 'export const source = 1;\n');
  await writeFile(join(dir, 'coverage.info'), ['SF:index.js\nDA:1,1\nend_of_record\n',
    ...Object.keys(excluded).map(path => `SF:${path}\nDA:1,0\nend_of_record\n`)].join(''));
  const result = invoke(dir, ['analyze', '--working-tree', '--import', 'lcov=coverage.info']);
  assert.equal(result.status, 0, result.stderr);
  const { subject } = JSON.parse(result.stdout) as Pick<Report, 'subject'>;
  const report = JSON.parse(invoke(dir, ['show', subject.id]).stdout) as Report;
  assert.deepEqual(report.scope, { files: 1, parsed: 1 });
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual((report.appliedConfig.source as { generatedExcluded: string[] }).generatedExcluded, ['dense.js', 'mapped.js']);
  assert.deepEqual(report.measurements.find(row => row.definition === definitions.coverage && row.target === 'repository'),
    { definition: definitions.coverage, target: 'repository', covered: 1, total: 1, value: 1 });
});

test('export writes the whole store without working trees and refuses to overwrite an existing site', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sha = 'a'.repeat(40);
  const report: Report = { schema: reportSchema, subject: { kind: 'commit', id: sha }, generatedAt: '2026-11-20T00:00:00.000Z',
    status: 'partial', scope: { files: 2, parsed: 1 },
    appliedConfig: { profile: 'private-config', source: { excludedPaths: ['private-path/**'], excludedDirectories: ['private-directory'] } },
    definitions: { [definitions.lines]: 'Physical lines', [definitions.coverage]: 'LCOV',
      [definitions.complexity]: 'Cyclomatic complexity', 'private/rule': 'private-rule' },
    diagnostics: [{ operation: 'test', state: 'failed', message: 'private-diagnostic' }], measurements: [
      { definition: definitions.lines, target: 'file', path: 'private-filename.ts', value: 11 },
      { definition: definitions.lines, target: 'file', path: 'examples/Dockerfile.dev.test', value: 4 },
      { definition: definitions.lines, target: 'file', path: 'readme.md', value: 7 },
      { definition: definitions.lines, target: 'file', path: 'deps/foo.qqx', value: 3 },
      { definition: definitions.complexity, target: 'function', path: 'private-filename.ts', name: 'private-function', line: 4, value: 3 },
      { definition: 'private/rule', target: 'file', path: 'private-filename.ts', value: 1 },
      { definition: definitions.coverage, target: 'repository', value: 0.5, covered: 2, total: 4 },
    ] };
  const store = new LocalReportStore(join(dir, '.repometry'));
  await store.save(report);
  await store.save({ ...report, subject: { kind: 'working-tree', id: 'b'.repeat(64) } });

  await writeFile(join(dir, '.repometry', 'components.json'), JSON.stringify([{ name: 'Old component', pathGlobs: ['private-*'] }]));
  const result = invoke(dir, ['report', 'html=viewer']);
  assert.equal(result.status, 0, result.stderr);
  const viewer = join(dir, 'viewer');
  const app = await readdir(resolve('target/main/ts/report/html/app'));
  const wire = await readdir(resolve('target/main/ts/report/json/wire'));
  const resources = await readdir(resolve('target/main/resources/viewer'));
  const scripts = [...app, ...wire].filter(name => name.endsWith('.js'));
  const assets = [...scripts, ...resources.filter(name => name.endsWith('.css') || name === 'index.html')];
  assert.deepEqual((await readdir(viewer)).sort(),
    [...assets, 'coverage.svg', 'details', 'maintainability.svg', 'pulls.json', 'summary.json'].sort());
  const html = await readFile(join(viewer, 'index.html'), 'utf8');
  assert.ok(html.includes(`name="repometry-project" content="${basename(dir)}"`));
  assert.match(html, /name="repometry-view" content="private"/);
  await expectShippedModules(viewer, html, scripts);
  const summaryText = await readFile(join(viewer, 'summary.json'), 'utf8');
  assert.doesNotMatch(summaryText, /private-/);
  const summary: unknown = JSON.parse(summaryText);
  const schemas = new Ajv2020({ schemas: [metricCatalog, summaryV1, compactV1, reportV2, fileMetricsV1] });
  const validSummary = schemas.compile<RepositorySummary>(summaryV1);
  assert.ok(validSummary(summary), JSON.stringify(validSummary.errors));
  assert.deepEqual(summary.commits.map(row => row.sha), [sha]);
  assert.ok(summary.commits[0]?.detail, 'the commit links its details');
  assert.equal(summary.commits[0].counts?.componentCount, 0, 'the former components file is ignored');
  assert.equal(summary.commits[0].generatedAt, report.generatedAt);
  assert.equal(summary.commits[0].maxComplexity, 3);
  assert.deepEqual(summary.commits[0].lineCoverage, { covered: 2, total: 4 });
  assert.equal(invoke(dir, ['report', 'html=viewer']).status, 0);

  await writeFile(join(dir, 'repometry.config.json'), JSON.stringify({ components: [
    { name: ' Matching component ', pathGlobs: ['private-*', 'private-*'], description: 'Source files' },
    { name: 'Empty component', pathGlobs: ['other/*'] },
  ], branch: 'report-branch' }));
  const detailed = invoke(dir, ['report', 'html=private-viewer', '--sources', 'none', '--title', 'Demo <"name">']);
  assert.equal(detailed.status, 0, detailed.stderr);
  const page = await readFile(join(dir, 'private-viewer', 'index.html'), 'utf8');
  assert.match(page, /name="repometry-view" content="private"/);
  assert.match(page, /name="repometry-project" content="Demo &lt;&quot;name&quot;&gt;"/);
  const initialSummary = JSON.parse(await readFile(join(dir, 'private-viewer', 'summary.json'), 'utf8'));
  assert.equal(initialSummary.commits.length, 1);
  assert.deepEqual(initialSummary.source, { branch: 'report-branch' });
  assert.deepEqual(initialSummary.commits[0].counts, { findingCount: 0, diagnosticCount: 1, componentCount: 2, hasCoverage: true });
  const firstPath = initialSummary.commits[0].detail as string;
  assert.match(firstPath, new RegExp(`^details/${sha}-[a-f0-9]{64}\\.json$`));
  const rawFirstDetail = await readFile(join(dir, 'private-viewer', firstPath), 'utf8');
  const validCompact = schemas.compile(compactV1);
  const validInspection = schemas.compile(inspectionV1);
  assert.ok(validSummary(initialSummary), JSON.stringify(validSummary.errors));
  assert.ok(validCompact(JSON.parse(rawFirstDetail)), JSON.stringify(validCompact.errors));
  assert.ok(validInspection(unpackJson(JSON.parse(rawFirstDetail))), JSON.stringify(validInspection.errors));
  const detail = unpackJson(JSON.parse(rawFirstDetail)) as InspectionAsset;
  assert.deepEqual(detail.context?.exclusions?.paths, ['private-path/**']);
  const { files, languages } = detail.inspection.metrics;
  const display = (path: string) => languages?.[files.find(file => file.path === path)!.language!];
  assert.deepEqual(display('private-filename.ts'), { id: 'typescript', label: 'TypeScript', color: '#3178c6', analysed: true });
  assert.deepEqual(display('examples/Dockerfile.dev.test'), { id: 'dockerfile', label: 'Dockerfile', color: '#4f9a94', analysed: true });
  assert.deepEqual(display('readme.md'), { id: 'markdown', label: 'Markdown', color: '#768390', analysed: true });
  assert.deepEqual(display('deps/foo.qqx'), { id: 'qqx', label: 'QQX', analysed: true });
  assert.ok(files.every(file => file.analysed === undefined));
  assert.deepEqual(await store.read(report.subject), report);
  assert.deepEqual(detail.inspection.components?.map(entry => [entry.component.name, entry.paths]),
    [['Matching component', ['private-filename.ts']], ['Empty component', []]]);
  assert.equal(detail.inspection.diagnostics[0]?.message, 'private-diagnostic');
  await store.save({ ...report, generatedAt: '2026-11-21T00:00:00.000Z', diagnostics: [] });
  const refreshed = invoke(dir, ['report', 'html=private-viewer', '--sources', 'none', '--branch', 'explicit-branch']);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const nextSummary = JSON.parse(await readFile(join(dir, 'private-viewer', 'summary.json'), 'utf8'));
  assert.notEqual(nextSummary.commits[0].detail, firstPath);
  assert.equal(nextSummary.commits[0].counts.diagnosticCount, 0);
  assert.deepEqual(nextSummary.source, { branch: 'explicit-branch' });
  assert.equal(await readFile(join(dir, 'private-viewer', firstPath), 'utf8'), rawFirstDetail);
  assert.equal(invoke(dir, ['report', 'html=private-viewer']).status, 0);
  const projectIndex = invoke(tmpdir(), ['projects', dir]);
  assert.equal(projectIndex.status, 0, projectIndex.stderr);
  const projects = await readFile(join(dir, 'projects.json'), 'utf8');
  assert.deepEqual(JSON.parse(projects).projects.map((entry: { name: string }) => entry.name), ['private-viewer', 'viewer']);
  assert.doesNotMatch(projects, /private-(?:filename|directory|config|diagnostic)/);

  await mkdir(join(dir, 'existing'));
  await writeFile(join(dir, 'existing', 'index.html'), 'keep me');
  const conflict = invoke(dir, ['report', 'html=existing']);
  assert.equal(conflict.status, 1);
  assert.equal(await readFile(join(dir, 'existing', 'index.html'), 'utf8'), 'keep me');
});

async function expectShippedModules(directory: string, html: string, scripts: readonly string[]): Promise<void> {
  const shipped = new Set(scripts);
  const entryPoints = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)];
  assert.ok(entryPoints.length > 0, 'The report HTML has a module entry point');
  function check(source: string, reference: string): void {
    assert.ok(reference.startsWith('.') && shipped.has(posix.join(posix.dirname(source), reference)),
      `${source} must resolve its module ${reference} inside the export`);
  }
  for (const entry of entryPoints) check('index.html', entry[1]!);
  for (const name of scripts) {
    const code = await readFile(join(directory, name), 'utf8');
    const ast = parse(code, { sourceType: 'module', createImportExpressions: true });
    traverseFast(ast, node => {
      if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        if (node.source) check(name, node.source.value);
      } else if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') {
        check(name, node.source.value);
      }
    });
  }
}

function invoke(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

test('the command registry handles scoped help, suggestions, version and plugin discovery', () => {
  const directory = process.cwd();
  const help = invoke(directory, ['help', 'report']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: repometry report/);
  assert.match(help.stdout, /--sources/);
  const unknown = invoke(directory, ['report', '--soruces', 'example']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Did you mean --sources/);
  assert.match(invoke(directory, ['--version']).stdout.trim(), /^\d+\.\d+\.\d+/);
  const listing = JSON.parse(invoke(directory, ['-C', directory, 'plugins']).stdout);
  assert.ok(listing.importers.includes('sarif-secrets'));
  assert.ok(listing.plugins.some((plugin: { id: string; kinds: string[] }) => plugin.id === 'github' && plugin.kinds.includes('source')));
});

test('report validates separate destinations and the default output is under the store workspace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-report-default-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const invalid = invoke(dir, ['report', 'html=out', 'json=out']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /separate output/);
  const result = invoke(dir, ['report']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(join(dir, '.repometry', 'report', 'html', 'index.html'), 'utf8')).includes('repometry-view'));
});

test('repository and store options are scoped to the commands that use them', () => {
  const directory = process.cwd();
  for (const [commands, option, value] of [
    [['view', 'projects', 'cache'], '--repo', directory],
    [['review', 'plugins', 'projects', 'cache'], '--store', '.repometry'],
  ] as const) {
    for (const command of commands) {
      const help = invoke(directory, ['help', command]);
      assert.equal(help.status, 0, help.stderr);
      assert.ok(!help.stdout.includes(option), help.stdout);
      const unknown = invoke(directory, [option, value, command]);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, new RegExp(option + ' is not an option of ' + command));
    }
  }
  assert.match(invoke(directory, ['help', 'analyze']).stdout, /-C, --repo DIR/);
  assert.match(invoke(directory, ['help', 'view']).stdout, /--store PATH/);
});
