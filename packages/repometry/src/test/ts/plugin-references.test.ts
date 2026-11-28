import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { inspect } from 'repometry';
import { codeStructure, findingResult, pluginManifestSchema, sourceFile } from 'repometry/plugin';
import { inspectionProfileDigest } from '../../main/ts/report/json/projections/inspection-context.js';
import type { Report } from 'repometry/report';
import { inspectionAsset } from '../../main/ts/report/json/projections/inspection-details.js';

const cli = resolve('target/main/ts/cli/main.js');
const localDefinition = {
  schema: 'urn:repometry:schema:plugin:1', id: 'my-checks', version: '1.2.3', category: 'maintainability',
  optionsSchema: { type: 'object', required: ['args'], additionalProperties: false,
    properties: { args: { type: 'array', items: { type: 'string' } } } },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'repometry-plugin-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsDir = join(root, 'settings');
  await mkdir(settingsDir);
  return {
    root, settingsDir,
    run: (...args: string[]) => runCLI(cli, root, args[0] === 'show' ? args : [...args, '--config', join(settingsDir, 'test.json')], settingsDir),
    config: (plugins: unknown, other = {}) => writeFile(join(settingsDir, 'test.json'), JSON.stringify({ plugins, ...other })),
    define: async (name: string, definition: object, create = '() => ({ operations: [], produces: [] })') =>
      writeFile(join(settingsDir, name), 'export default { ...' + JSON.stringify(definition) + ', create: ' + create + ' };'),
  };
}

function runCLI(cliPath: string, cwd: string, args: readonly string[], path: string) {
  return spawnSync(process.execPath, [cliPath, ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, PATH: path + delimiter + process.env.PATH } });
}

function listed(output: ReturnType<Awaited<ReturnType<typeof fixture>>['run']>, id: string) {
  assert.equal(output.status, 0, output.stderr);
  const value = JSON.parse(output.stdout) as { schema: string; plugins: { id: string }[] };
  assert.equal(value.schema, 'urn:repometry:schema:plugin-list:2');
  return value.plugins.find(entry => entry.id === id);
}

test('local plugins resolve beside the config and declare version and options', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'sample.js'), 'export const n = 1;');
  await setup.define('checks.mjs', localDefinition,
    '(options, context) => { if (options.args[0] !== "--fixture" || context.root !== process.cwd()) throw new Error("wrong context"); return { operations: [], produces: [] }; }');
  await setup.config([{ use: './checks.mjs', options: { args: ['--fixture'] } }]);
  assert.deepEqual(listed(setup.run('plugins'), 'my-checks'), {
    id: 'my-checks', category: 'maintainability', version: '1.2.3', use: './checks.mjs', versionSource: 'manifest',
    available: true, optionsSchema: localDefinition.optionsSchema,
  });
  const analysis = setup.run('analyze', '--working-tree');
  assert.equal(analysis.status, 0, analysis.stderr);
});

test('invalid options and retired forms name the file, path and replacement', async t => {
  const setup = await fixture(t);
  const prefix = 'repometry: ' + join(setup.settingsDir, 'test.json') + ': ';
  await setup.define('checks.mjs', localDefinition, '() => { throw new Error("factory should not run"); }');
  for (const [options, expected] of [
    [{ args: [42] }, 'plugins/0/options/args/0 must be string'],
    [{}, 'plugins/0/options/args is required'],
    [{ args: [], extra: true }, 'plugins/0/options/extra is not allowed'],
  ] as const) {
    await setup.config([{ use: './checks.mjs', options }]);
    assert.equal(setup.run('plugins').stderr.trim(), prefix + expected);
  }
  for (const [config, expected] of [
    [{ sources: 'github' }, 'sources is renamed. Write source.'],
    [{ components: [{ name: 'CLI', pathGlobs: ['src/**'] }] }, 'components/0/pathGlobs is renamed. Write include.'],
    [{ exclude: [42] }, 'Profile exclude/0 must be a string'],
    [{ ignore: [{ tool: 'repometry', reason: 'fixture' }] }, 'ignore/0/tool is renamed. Write plugin.'],
    [{ ignore: [{ rule: 'example', reason: 'fixture' }] }, 'ignore/0/rule is renamed. Write check.'],
    [{ ignore: [{ category: 'coverage', reason: 'fixture' }] }, 'ignore/0/path is required for coverage to identify the files to exclude'],
  ] as const) {
    await setup.config([], config);
    assert.equal(setup.run('plugins').stderr.trim(), prefix + expected);
  }
  await setup.config([{ id: 'legacy', image: 'old', command: ['old'] }]);
  assert.equal(setup.run('plugins').stderr.trim(), prefix +
    'plugins/0 describes a plugin inline. Move it into a manifest file and reference it with { "use": "./plugin.json" }.');

  for (const [old, replacement] of [
    ['api', 'schema'], ['kinds', 'category'], ['providesLanguages', 'languages'], ['claims', 'include'],
    ['settings', 'options'], ['rules', 'checks'], ['config', 'optionsSchema'],
  ] as const) {
    await setup.define('checks.mjs', { ...localDefinition, [old]: 'retired' });
    await setup.config([{ use: './checks.mjs', options: { args: [] } }]);
    assert.equal(setup.run('plugins').stderr.trim(), prefix +
      'plugins/0/manifest/' + old + ' is retired. Write ' + replacement + '.');
  }
  await setup.define('checks.mjs', { ...localDefinition, schema: 'unknown' });
  assert.equal(setup.run('plugins').stderr.trim(), prefix + 'plugins/0/manifest/schema must be urn:repometry:schema:plugin:1');
});

test('plugin paths identify the failing include or exclude and language measures list their allowed values', async t => {
  const setup = await fixture(t);
  const prefix = 'repometry: ' + join(setup.settingsDir, 'test.json') + ': ';
  for (const [entry, expected] of [
    [{ include: ['/outside'] }, 'plugins/0/include/0 must be a repository-relative path or glob. Received "/outside".'],
    [{ exclude: [42] }, 'plugins/0/exclude/0 must be a string'],
  ] as const) {
    await setup.config([{ use: './checks.mjs', ...entry }]);
    assert.equal(setup.run('plugins').stderr.trim(), prefix + expected);
  }
  await setup.define('language.mjs', { schema: pluginManifestSchema, id: 'fixture-language', category: 'language',
    languages: [{ id: 'fixture', label: 'Fixture', include: ['**/*.fixture'], measures: ['structuralRules'] }] });
  await setup.config(['./language.mjs']);
  assert.equal(setup.run('plugins').stderr.trim(), prefix + 'plugins/0/manifest/languages/0/measures/0 must be one of '
    + '"functions", "cyclomaticComplexity", "cognitiveComplexity", "classes", "commentLines", "codeLines", "duplication", "checks"');
});

test('language checks use the stored measure name and remain visible in the inspection projection', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'code.fixture'), 'sample\n');
  const output = join(setup.root, '.repometry', 'data');
  const report = await inspect({ directory: setup.root, output, source: { workingTree: true },
    plugins: [{ schema: pluginManifestSchema, id: 'fixture-parser', category: 'language',
      languages: [{ id: 'fixture', label: 'Fixture', include: ['**/*.fixture'], measures: ['checks'] }],
      create: () => ({
        produces: [{ contract: codeStructure.id, persistence: 'transient' }],
        operations: [{ id: 'parse', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
          execute: inputs => ({ path: inputs.read('source', sourceFile).path, lines: 1, functions: 0, cyclomaticFunctions: [] }) }],
      }) }],
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.scope.parsed, 1);
  const shown = setup.run('show', report.subject.id, '--store', output);
  assert.equal(shown.status, 0, shown.stderr);
  const stored = JSON.parse(shown.stdout) as Report;
  const plugins = stored.appliedConfig.plugins as readonly { id: string; providesLanguages?: readonly { measures?: readonly string[] }[] }[];
  assert.deepEqual(plugins.find(({ id }) => id === 'fixture-parser')?.providesLanguages?.[0]?.measures, ['structuralRules']);
  const profile = inspectionAsset(stored).inspection.profile;
  assert.ok(profile?.rules.some(({ rule }) => rule === 'function-complexity'));
  assert.ok(profile?.languages?.some(({ id }) => id === 'fixture'));
});

test('an unavailable plugin does not run its factory and appears in the listing and report', async t => {
  const setup = await fixture(t);
  const requires = { tools: ['repometry-fixture-missing-binary'] };
  await setup.define('checks.mjs', { ...localDefinition, requires },
    '() => { throw new Error("factory should not run"); }');
  await setup.config([{ use: './checks.mjs', options: { args: [] } }]);
  const unavailableReason = 'required executable repometry-fixture-missing-binary is not on PATH';
  assert.deepEqual(listed(setup.run('plugins'), 'my-checks'), {
    id: 'my-checks', category: 'maintainability', version: '1.2.3', use: './checks.mjs', versionSource: 'manifest',
    available: false, reason: unavailableReason, requires, optionsSchema: localDefinition.optionsSchema,
  });
  await writeFile(join(setup.root, 'sample.js'), 'export const ok = 1;\n');
  const analyzed = setup.run('analyze', '--working-tree');
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const report = setup.run('show', JSON.parse(analyzed.stdout).subject.id);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).appliedConfig.plugins.find((entry: { id: string }) => entry.id === 'my-checks').unavailableReason, unavailableReason);
});

test('docker references read the embedded label with image inspect and use its version', async t => {
  const setup = await fixture(t);
  const manifest = {
    schema: 'urn:repometry:schema:plugin:1', id: 'fixture', version: '3.2.1', category: 'language', command: ['fixture'],
    scope: 'file', tools: { fixture: '1' }, languages: [{ id: 'fixture', label: 'Fixture', include: ['**/*.fixture'] }],
  };
  const image = 'sha256:' + 'f'.repeat(64);
  await writeFile(join(setup.settingsDir, 'image.json'),
    JSON.stringify([{ Id: image, Config: { Labels: { 'repometry.plugin': JSON.stringify(manifest) } } }]));
  await writeFile(join(setup.settingsDir, 'docker'), '#!/bin/sh\n[ "$1 $2 $3 $4" = "image inspect -- fixture:1" ] || exit 99\ncat "' +
    join(setup.settingsDir, 'image.json') + '"\n', { mode: 0o755 });
  await setup.config(['docker:fixture:1']);
  assert.deepEqual(listed(setup.run('plugins'), 'fixture'), {
    id: 'fixture', version: '3.2.1', category: 'language', use: 'docker:fixture:1', versionSource: 'manifest',
    available: true,
    tools: manifest.tools,
    languages: manifest.languages,
  });
});

test('moving a Docker tag records a new image ID and changes the inspection profile', async t => {
  const setup = await fixture(t);
  const manifest = {
    schema: pluginManifestSchema, id: 'docker-check', version: '1.0.0', category: 'maintainability', command: ['fixture'],
    scope: 'file', tools: { fixture: '1' }, include: ['**/*.js'],
  };
  const imageMetadata = join(setup.settingsDir, 'image.json');
  const invokedImage = join(setup.settingsDir, 'invoked-image');
  const product = JSON.stringify({ kind: 'product', contract: findingResult.id, value: { findings: [], measurements: [] } });
  await writeFile(join(setup.settingsDir, 'docker'), [
    '#!/bin/sh',
    'FIXTURE="$(dirname "$0")"',
    'case "$1 $2 $3 $4" in',
    '  "image inspect -- fixture:1") cat "$FIXTURE/image.json"; exit ;;',
    'esac',
    '[ "$1" = run ] || exit 99',
    'while [ "$1" != -- ]; do [ "$#" -gt 0 ] || exit 99; shift; done',
    'printf "%s" "$2" > "$FIXTURE/invoked-image"',
    'cat >/dev/null',
    'printf "%s\n" ' + "'" + product + "'",
  ].join('\n') + '\n', { mode: 0o755 });
  await writeFile(join(setup.root, 'sample.js'), 'export const n = 1;\n');
  await setup.config(['docker:fixture:1']);
  const digests = [];
  for (const hex of ['a', 'b']) {
    const image = 'sha256:' + hex.repeat(64);
    await writeFile(imageMetadata, JSON.stringify([{ Id: image, Config: { Labels: { 'repometry.plugin': JSON.stringify(manifest) } } }]));
    const analysis = setup.run('analyze', '--working-tree');
    assert.equal(analysis.status, 0, analysis.stderr);
    const shown = setup.run('show', JSON.parse(analysis.stdout).subject.id);
    assert.equal(shown.status, 0, shown.stderr);
    const report = JSON.parse(shown.stdout) as Report;
    assert.equal(report.status, 'complete', JSON.stringify(report.diagnostics));
    assert.equal(await readFile(invokedImage, 'utf8'), image);
    const plugins = report.appliedConfig.plugins as readonly { id: string; image?: string }[];
    assert.equal(plugins.find(entry => entry.id === manifest.id)?.image, image);
    const profile = inspectionProfileDigest(report);
    assert.ok(profile);
    digests.push(profile);
  }
  assert.notEqual(digests[0], digests[1]);
});

test('installed npm plugins resolve from the CLI and read their version from package.json', async t => {
  const setup = await fixture(t);
  const modules = join(setup.root, 'installation', 'node_modules');
  const installedCli = join(modules, 'repometry');
  const installedPlugin = join(modules, 'fixture-package');
  await mkdir(installedPlugin, { recursive: true });
  await mkdir(installedCli);
  const existing = resolve('../../node_modules');
  for (const dependency of await readdir(existing)) {
    if (dependency === 'repometry' || dependency.startsWith('.')) continue;
    await symlink(join(existing, dependency), join(modules, dependency), 'junction');
  }
  await cp(resolve('target/main'), join(installedCli, 'target/main'), { recursive: true });
  await cp(resolve('package.json'), join(installedCli, 'package.json'));
  await writeFile(join(installedPlugin, 'package.json'), JSON.stringify({ name: 'fixture-package', version: '4.2.1',
    type: 'module', exports: { import: './plugin.js' } }));
  await writeFile(join(installedPlugin, 'plugin.js'),
    'export default { schema: "urn:repometry:schema:plugin:1", id: "npm-fixture", version: "0.1.0", category: "maintainability", create: () => ({ operations: [], produces: [] }) };');
  const run = () => runCLI(join(installedCli, 'target/main/ts/cli/main.js'), setup.root,
    ['plugins', '--config', join(setup.settingsDir, 'test.json')], setup.settingsDir);
  for (const use of ['npm:fixture-package', 'fixture-package']) {
    await setup.config([use]);
    assert.deepEqual(listed(run(), 'npm-fixture'), { id: 'npm-fixture', version: '4.2.1', category: 'maintainability',
      use, versionSource: 'package.json', available: true });
  }
  await setup.config(['npm:fixture-package', 'fixture-package']);
  assert.equal(run().stderr.trim(),
    'repometry: ' + join(setup.settingsDir, 'test.json') + ': plugins/1 plugin npm-fixture from fixture-package duplicates npm:fixture-package');
  await setup.config(['npm:repometry-fixture-package-missing']);
  assert.match(run().stderr.trim(),
    /^repometry: .*test\.json: plugins\/0 could not resolve npm package repometry-fixture-package-missing from Repometry at /);
});

test('the built-in reference stays in its original position and duplicates are rejected', async t => {
  const setup = await fixture(t);
  await setup.config([]);
  const defaults = setup.run('plugins');
  assert.equal(defaults.status, 0, defaults.stderr);
  await setup.config([{ use: 'secrets', include: ['src/**'], exclude: [] }]);
  const scoped = setup.run('plugins');
  assert.equal(scoped.status, 0, scoped.stderr);
  const ids = (stdout: string) => JSON.parse(stdout).plugins.map((entry: { id: string }) => entry.id);
  assert.deepEqual(ids(scoped.stdout), ids(defaults.stdout));
  assert.deepEqual(listed(scoped, 'secrets'), {
    ...listed(defaults, 'secrets'), include: ['src/**'], exclude: [],
  });
  await setup.config(['secrets', 'secrets']);
  assert.equal(setup.run('plugins').stderr.trim(),
    'repometry: ' + join(setup.settingsDir, 'test.json') + ': plugins/1 plugin secrets from secrets duplicates secrets');
});

test('a default language package reference configures its existing parser', async t => {
  const setup = await fixture(t);
  for (const use of ['language-go', '@repometry/language-go', 'npm:@repometry/language-go']) {
    await setup.config([{ use, exclude: ['testdata/**'] }]);
    const entry = listed(setup.run('plugins'), 'language-go') as { use?: string; exclude?: readonly string[] };
    assert.equal(entry.use, use);
    assert.deepEqual(entry.exclude, ['testdata/**']);
  }
});

test('plugins lists each enabled language grammar and its version', async t => {
  const setup = await fixture(t);
  await setup.config([]);
  const defaults = setup.run('plugins');
  assert.equal(listed(defaults, 'language-ruby'), undefined);
  assert.equal(listed(defaults, 'language-kotlin'), undefined);
  await setup.config(['@repometry/language-ruby', '@repometry/language-kotlin']);
  const output = setup.run('plugins');
  const expected = {
    'language-go': { 'tree-sitter-go': '0.25.0' },
    'language-python': { 'tree-sitter-python': '0.25.0' },
    'language-java': { 'tree-sitter-java': '0.23.5' },
    'language-ruby': { 'tree-sitter-ruby': '0.23.1' },
    'language-php': { 'tree-sitter-php': '0.24.2' },
    'language-kotlin': { '@tree-sitter-grammars/tree-sitter-kotlin': '1.1.0' },
  };
  for (const [id, tools] of Object.entries(expected)) {
    const entry = listed(output, id) as { tools?: Readonly<Record<string, string>> };
    assert.deepEqual(entry.tools, tools, id);
  }
});

test('scope replaces plugin selection and cannot restore globally excluded files', async t => {
  const setup = await fixture(t);
  const definition = { ...localDefinition, include: ['**/*.log'], exclude: ['allow.js'] };
  const factory = String.raw`(options) => {
    const source = { id: 'repometry.source-file/v1', accepts: value => typeof value?.path === 'string' };
    const sources = { id: 'repometry.source-files/v1', accepts: value => Array.isArray(value) };
    const output = { id: 'repometry.findings-and-measurements/v1', accepts: value => Array.isArray(value?.findings) };
    const result = (files, check) => ({ measurements: [], findings: files.map(({path}) => ({
      check, path, level: 'low', message: options.args[0]
    })) });
    return { produces: [{ contract: output.id, persistence: 'report' }], operations: [
      { id: 'single', role: 'inspection', inputs: { source }, output, execute: inputs => result([inputs.read('source', source)], 'single') },
      { id: 'many', role: 'inspection', scope: 'repository', inputs: { sources }, output,
        execute: inputs => result(inputs.read('sources', sources), 'many') }
    ] };
  }`;
  await setup.define('checks.mjs', definition, factory);
  await setup.config([{ use: './checks.mjs', include: ['**/*.js'], exclude: ['other.js'], options: { args: ['fixture'] } }],
    { exclude: ['outside.js'] });
  for (const path of ['allow.js', 'other.js', 'outside.js', 'default.log']) {
    await writeFile(join(setup.root, path), 'export const direct = 42;\n');
  }
  const analyzed = setup.run('analyze', '--working-tree');
  assert.equal(analyzed.status, 0, analyzed.stderr);
  const shown = setup.run('show', JSON.parse(analyzed.stdout).subject.id);
  assert.equal(shown.status, 0, shown.stderr);
  const report = JSON.parse(shown.stdout);
  const findings = report.findings.filter((finding: { tool: string }) => finding.tool === 'my-checks');
  assert.deepEqual(findings.map(({ path, rule, message }: { path: string; rule: string; message: string }) => [path, rule, message]),
    [['allow.js', 'single', 'fixture'], ['allow.js', 'many', 'fixture']]);
  const provenance = report.appliedConfig.plugins.find((entry: { id: string }) => entry.id === 'my-checks');
  assert.deepEqual(provenance.include, ['**/*.js']);
  assert.deepEqual(provenance.exclude, ['other.js']);
  assert.deepEqual(provenance.settings, { args: ['fixture'] });
});

test('built-in parser scope changes which files are parsed', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'keep.js'), 'export const keep = 1;\n');
  await writeFile(join(setup.root, 'skip.js'), 'export const skip = 2;\n');
  await setup.config([{ use: 'babel-syntax', include: ['keep.js'], exclude: [] }]);
  const analyzed = setup.run('analyze', '--working-tree');
  assert.equal(analyzed.status, 0, analyzed.stderr);
  assert.equal(JSON.parse(analyzed.stdout).scope.parsed, 1);
});

test('coverage uses the configured plugin scope without removing files from the inspection', async t => {
  const setup = await fixture(t);
  await setup.config([{ use: 'lcov', exclude: ['skip.js'] }]);
  await writeFile(join(setup.root, 'keep.js'), 'export const kept = 1;\n');
  await writeFile(join(setup.root, 'skip.js'), 'export const skipped = 2;\n');
  const coverage = join(setup.settingsDir, 'lcov.info');
  await writeFile(coverage, 'SF:keep.js\nDA:1,1\nend_of_record\nSF:skip.js\nDA:1,0\nend_of_record\n');
  const analyzed = setup.run('analyze', '--working-tree', '--import', 'lcov=' + coverage);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  assert.equal(JSON.parse(analyzed.stdout).scope.parsed, 2);
  const shown = setup.run('show', JSON.parse(analyzed.stdout).subject.id);
  assert.equal(shown.status, 0, shown.stderr);
  const measurements = JSON.parse(shown.stdout).measurements as { definition: string; path?: string }[];
  const covered = measurements.filter(({ definition }) => definition === 'repometry.lcov-line-coverage/v1');
  assert.deepEqual(covered.map(item => item.path), ['keep.js', undefined]);
});

test('plugin discovery lists checks without creating operations', async t => {
  const setup = await fixture(t);
  const checks = [{ id: 'unused', description: 'A variable is never read' }];
  await setup.define('checks.mjs', { ...localDefinition, checks }, '() => { throw new Error("factory should not run"); }');
  await setup.config([{ use: './checks.mjs', options: { args: [] } }]);
  const output = listed(setup.run('plugins'), 'my-checks');
  assert.deepEqual((output as { checks?: unknown })?.checks, checks);
});

test('coverage ignore leaves source intact and excludes only coverage from the review', async t => {
  const setup = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', setup.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(setup.root, 'keep.js'), 'export const good = 1;\n');
  await writeFile(join(setup.root, 'skip.js'), 'export const skipped = 1;\n');
  git('add', 'keep.js', 'skip.js');
  git('commit', '-qm', 'files');
  await setup.config([], { ignore: [{ category: 'coverage', path: ['skip.js', 'unused/**'], reason: 'fixtures' }] });
  const lcov = join(setup.settingsDir, 'lcov.info');
  await writeFile(lcov, 'SF:keep.js\nDA:1,1\nend_of_record\nSF:skip.js\nDA:1,0\nend_of_record\n');
  const analyzed = setup.run('analyze', '--import', 'lcov=' + lcov);
  assert.equal(analyzed.status, 0, analyzed.stderr);
  assert.equal(JSON.parse(analyzed.stdout).scope.parsed, 2);
  const review = setup.run('review', base, '--import', 'lcov=' + lcov);
  assert.equal(review.status, 0, review.stderr);
  const report = JSON.parse(review.stdout);
  assert.equal(report.changedFiles, 2);
  assert.equal(report.coverage.total, 1);
  assert.equal(report.coverage.covered, 1);
});

test('inspect accepts author manifests without exposing created engine plugins', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'sample.md'), '# One file\n');
  const report = await inspect({ directory: setup.root, output: join(setup.root, '.repometry', 'data'), source: { workingTree: true },
    plugins: [{ schema: pluginManifestSchema, id: 'inspect-fixture', category: 'maintainability',
      include: ['**/*.md'], checks: [{ id: 'example' }], create: () => ({
        produces: [{ contract: findingResult.id, persistence: 'report' }],
        operations: [{ id: 'check', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
          execute(inputs) {
            const { path } = inputs.read('source', sourceFile);
            return { measurements: [], findings: [{ check: 'example', path, level: 'low', message: 'fixture finding' }] };
          } }],
      }) }],
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.pluginData?.rules?.find(entry => entry.plugin === 'inspect-fixture')?.rules[0]?.category, 'lint');
  assert.deepEqual(report.findings?.filter(finding => finding.tool === 'inspect-fixture'),
    [{ tool: 'inspect-fixture', rule: 'example', category: 'lint', path: 'sample.md', level: 'low', message: 'fixture finding' }]);
});
