import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import configSchema from '../../main/resources/report/json/config-v2.schema.json' with { type: 'json' };
import dockerSchema from '@repometry/core/plugin-v1.schema.json' with { type: 'json' };
import { parseConfig } from '../../main/ts/cli/config.js';
import { inspect } from '../../main/ts/compose/inspect.js';
import { dockerPluginFile } from '../../main/ts/compose/process-plugins.js';
import { DockerToolRunner } from '../../main/ts/api/process/docker-tool-runner.js';
import { processPlugin } from '../../main/ts/api/process/plugin.js';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import { codeStructures } from '@repometry/core/internal/model/code-structure.js';
import { sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import type { FileMetricsReport } from '../../main/ts/report/json/wire/file-metrics-model.js';
import type { Report } from '@repometry/core/internal/model/report.js';

const cli = resolve('target/main/ts/cli/main.js');
const digest = 'a'.repeat(64);
const fixture = {
  schema: 'urn:repometry:schema:plugin:1', category: 'language', id: 'fixture', version: '1.0.0', scope: 'repository',
  image: 'sha256:' + digest, command: ['node', '/tools/parse.js'],
  tools: { node: '26' },
  languages: [{ id: 'fixture', label: 'Fixture', color: '#123456', include: ['**/*.fixture'] }],
};

test('the standalone config schema validates the same plugin declarations as the CLI', () => {
  const schemas = new Ajv2020();
  const validate = schemas.compile(configSchema);
  const config = { plugins: ['./fixture.json', { use: './checks.mjs', include: ['src/**'], exclude: [], options: { strict: true } }] };
  assert.ok(validate(config), schemas.errorsText(validate.errors));
  assert.equal(validate({ ...config, unknownKey: true }), false);
  assert.equal(validate.errors?.[0]?.keyword, 'additionalProperties');
  assert.equal(validate({ plugins: [fixture] }), false);
  const manifest = schemas.compile(dockerSchema);
  assert.ok(manifest(fixture), schemas.errorsText(manifest.errors));
  assert.equal(manifest({ ...fixture, command: [] }), false);
  assert.equal(manifest.errors?.[0]?.instancePath, '/command');
});

test('component glob validation agrees between config and its schema', () => {
  const validate = new Ajv2020().compile(configSchema);
  const config = (include: string[]) => ({ components: [{ name: ' Tools ', include, description: 'Build tools' }] });
  const valid = config(['src/tools/**', 'src/tools/**', '.github/workflows/*.yml']);
  assert.ok(validate(valid), JSON.stringify(validate.errors));
  assert.deepEqual(parseConfig(valid).components,
    [{ name: 'Tools', pathGlobs: ['src/tools/**', '.github/workflows/*.yml'], description: 'Build tools' }]);
  for (const value of [[], ['/etc'], ['C:/src'], ['src\\file'], ['src//file'], ['src/../file'], ['./src'], ['src/']]) {
    assert.equal(validate(config(value)), false, JSON.stringify(value));
    assert.throws(() => parseConfig(config(value)), /repository-relative include globs/);
  }
  assert.throws(() => parseConfig({ components: [...valid.components, { name: 'Tools', include: ['other/**'] }] }),
    /components\/1\/name duplicates Tools/);
});

test('configured repository parsers opt into file independence explicitly', async t => {
  const operation = async (definition: unknown) => {
    const { manifest } = await configuration(t, definition);
    return (await dockerPluginFile(manifest, { use: './fixture.json' }, 'Config plugins/0')).plugin.operations[0];
  };
  const defaultOperation = await operation(fixture);
  const independent = await operation({ ...fixture, fileIndependent: true });
  const dependent = await operation({ ...fixture, fileIndependent: false });
  await assert.rejects(operation({ ...fixture, fileIndependent: 'true' }),
    { message: 'Config plugins/0/manifest/fileIndependent must be boolean' });
  if (!defaultOperation || !independent || !dependent) return;
  assert.equal(Object.hasOwn(defaultOperation, 'fileIndependent'), false);
  assert.equal(independent.fileIndependent, true);
  assert.equal(dependent.fileIndependent, false);
  assert.equal(independent.implementation, defaultOperation.implementation);
});

interface ListedPlugin {
  readonly id: string;
  readonly available: boolean;
  readonly languages?: readonly { readonly id: string }[];
}

function entries(json: string): readonly ListedPlugin[] {
  return (JSON.parse(json) as { plugins: readonly ListedPlugin[] }).plugins;
}

async function configuration(t: TestContext, plugin: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-configured-plugin-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const manifest = join(directory, 'fixture.json');
  await writeFile(manifest, JSON.stringify(plugin));
  await writeFile(join(directory, 'repometry.config.json'), JSON.stringify({ plugins: ['./fixture.json'] }));
  return { directory, manifest, run: (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' }) };
}

test('configured syntax loads and validates but is not included in the plugins listing', async t => {
  const syntax = { lineComments: [';'], strings: [{ quote: '~' }], keywords: ['zap'] };
  const definition = { ...fixture, languages: [{ ...fixture.languages[0]!, syntax }] };
  const { run, manifest } = await configuration(t, definition);
  const configured = await dockerPluginFile(manifest, { use: './fixture.json' }, 'Config plugins/0');
  assert.deepEqual(configured.plugin.providesLanguages?.[0]?.syntax, syntax);
  const invalid = { ...definition, languages: [{ ...fixture.languages[0]!, syntax: { lineComments: [''] } }] };
  const bad = await configuration(t, invalid);
  await assert.rejects(dockerPluginFile(bad.manifest, { use: './fixture.json' }, 'Config plugins/0'),
    { message: 'Config plugins/0/manifest/languages/0/syntax/lineComments/0 must NOT have fewer than 1 characters' });
  const output = run('plugins');
  assert.equal(output.status, 0, output.stderr);
  assert.ok(entries(output.stdout).some(plugin => plugin.id === 'fixture'));
  assert.ok(entries(output.stdout).every(plugin =>
    plugin.languages?.every(language => !Object.hasOwn(language, 'syntax')) ?? true));
});

test('plugins lists configured languages and effective file claims before running any tools', async t => {
  const { run } = await configuration(t, fixture);
  const configured = run('plugins');
  assert.equal(configured.status, 0, configured.stderr);
  const list = entries(configured.stdout);
  assert.deepEqual(list.find(entry => entry.id === 'fixture'), {
    id: 'fixture', version: '1.0.0', category: 'language',
    use: './fixture.json', versionSource: 'manifest',
    available: list.find(entry => entry.id === 'fixture')?.available,
    tools: fixture.tools,
    ...(!list.find(entry => entry.id === 'fixture')?.available ? { reason: 'required executable docker is not on PATH' } : {}),
    languages: [{ id: 'fixture', label: 'Fixture', color: '#123456', include: ['**/*.fixture'] }],
  });
  assert.ok(list.find(entry => entry.id === 'babel-syntax')?.languages?.some(language => language.id === 'typescript'));
  const builtin = run('plugins', '--no-config');
  assert.equal(builtin.status, 0, builtin.stderr);
  assert.ok(entries(builtin.stdout).every(entry => entry.id !== 'fixture'));
});

test('invalid process plugin declarations name the field that needs correction', async t => {
  const invalid = [
    [{ ...fixture, image: '--invalid' }, 'image'],
    [{ ...fixture, command: [] }, 'command'],
    [{ ...fixture, limits: { pidsLimit: 0 } }, 'pidsLimit'],
  ] as const;
  for (const [plugin, field] of invalid) {
    const { run } = await configuration(t, plugin);
    const result = run('plugins');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp('plugins/0/manifest/(?:limits/)?' + field));
  }
});

const toolImage = process.env.REPOMETRY_TOOL_TEST_IMAGE;
test('configured process plugins use the same source routing and packed result as registered plugins', { skip: !toolImage }, async t => {
  const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', toolImage!], { encoding: 'utf8' }).trim();
  const parser = `
    const fs = require('node:fs');
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const rows = request.inputs.files.files.map(({ path }) => {
      const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\\n');
      return { path, lines: lines.length, functions: 1, classes: 0, commentLines: 0, cognitiveComplexity: 0,
        cyclomaticFunctions: [{ name: 'measure', value: 2 }], cognitiveFunctions: [], observations: [],
        clones: { path, codeLines: lines.map((_, index) => index + 1), candidates: [] } };
    });
    process.stdout.write(JSON.stringify({ kind: 'product', contract: 'repometry.code-structures/v1', value: rows }) + '\\n');
  `;
  const { run, directory } = await configuration(t, { ...fixture, image, command: ['node', '-e', parser] });
  await writeFile(join(directory, 'sample.fixture'), 'choose\nchoose again\n');
  const result = run('analyze', '--working-tree');
  assert.equal(result.status, 0, result.stderr);
  const analyzed = JSON.parse(result.stdout);
  assert.deepEqual(analyzed.scope, { files: 1, parsed: 1 });
  const shown = run('show', analyzed.subject.id, '--files');
  assert.equal(shown.status, 0, shown.stderr);
  const { files, languages } = JSON.parse(shown.stdout) as FileMetricsReport;
  const chosen = files.find(file => file.path === 'sample.fixture')!;
  assert.deepEqual(languages?.[chosen.language!],
    { id: 'fixture', label: 'Fixture', color: '#123456', analysed: true });
  assert.equal(chosen.provider, 'fixture/parse');
  assert.equal(chosen.complexity?.maximum, 2);
  const raw = run('show', analyzed.subject.id);
  assert.equal(raw.status, 0, raw.stderr);
  const fromConfig = JSON.parse(raw.stdout) as Report;
  const plugin = processPlugin({
    id: fixture.id, version: fixture.version, api: pluginApi, kinds: ['language'], tools: fixture.tools,
    providesLanguages: [{ id: 'fixture', label: 'Fixture', color: '#123456', globs: ['**/*.fixture'] }],
    produces: [{ contract: codeStructures.id, persistence: 'transient' }],
    operations: [{ id: 'parse', role: 'provider', scope: 'repository', inputs: { files: sourceFiles }, output: codeStructures,
      argv: ['node', '-e', parser], timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 }],
  }, new DockerToolRunner(image, { memoryBytes: 512 * 1024 * 1024, pidsLimit: 128 }));
  const output = join(directory, '.repometry', 'api');
  const inspected = await inspect({ directory, output, source: { workingTree: true }, plugins: [plugin] });
  const fromApi = await new LocalReportStore(output).read(inspected.subject);
  assert.deepEqual(fromConfig.measurements, fromApi.measurements);
  assert.deepEqual(fromConfig.pluginData, fromApi.pluginData);
  assert.deepEqual(fromConfig.findings, fromApi.findings);
  assert.deepEqual(fromConfig.appliedConfig.operations, fromApi.appliedConfig.operations);
});
