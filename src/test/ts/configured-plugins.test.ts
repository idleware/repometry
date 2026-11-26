import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import configSchema from '../../main/resources/report/json/config-v1.schema.json' with { type: 'json' };
import processPluginsSchema from '../../main/resources/config/process-plugins-v1.schema.json' with { type: 'json' };
import { inspect } from '../../main/ts/compose/inspect.js';
import { readProcessPlugins } from '../../main/ts/compose/process-plugins.js';
import { DockerToolRunner, codeStructures, pluginApi, processPlugin, sourceFiles } from '../../main/ts/plugin.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';
import type { FileMetricsReport } from '../../main/ts/report/json/wire/file-metrics-model.js';
import type { Report } from '../../main/ts/core/model/report.js';

const cli = resolve('target/main/ts/cli/main.js');
const digest = 'a'.repeat(64);
const fixture = {
  id: 'fixture', version: '1.0.0', scope: 'repository',
  image: 'sha256:' + digest, command: ['node', '/tools/parse.js'],
  claims: { extensions: ['.fixture'] },
  tools: { node: '26' },
  providesLanguages: [{ id: 'fixture', label: 'Fixture', color: '#123456' }],
};

test('the standalone config schema validates the same plugin declarations as the CLI', () => {
  const schemas = new Ajv2020();
  const validate = schemas.compile(configSchema);
  const config = { plugins: [fixture] };
  assert.ok(validate(config), schemas.errorsText(validate.errors));
  assert.equal(validate({ ...config, unknownKey: true }), false);
  assert.equal(validate.errors?.[0]?.keyword, 'additionalProperties');
  assert.equal(validate({ plugins: [{ ...fixture, command: [] }] }), false);
  assert.equal(validate.errors?.[0]?.instancePath, '/plugins/0/command');
  assert.deepEqual(schemas.getSchema(processPluginsSchema.$id)?.schema, processPluginsSchema);
});

test('configured repository parsers opt into file independence explicitly', () => {
  const operation = (definition: unknown) => readProcessPlugins([definition])[0]!.operations[0]!;
  const defaultOperation = operation(fixture);
  const independent = operation({ ...fixture, fileIndependent: true });
  const dependent = operation({ ...fixture, fileIndependent: false });
  assert.equal(Object.hasOwn(defaultOperation, 'fileIndependent'), false);
  assert.equal(independent.fileIndependent, true);
  assert.equal(dependent.fileIndependent, false);
  assert.equal(independent.implementation, defaultOperation.implementation);
  assert.throws(() => operation({ ...fixture, fileIndependent: 'true' }), /plugins\/0\/fileIndependent.*boolean/);
});

interface ListedPlugin {
  readonly id: string;
  readonly providesLanguages?: readonly { readonly id: string }[];
}

function entries(json: string): readonly ListedPlugin[] {
  return (JSON.parse(json) as { plugins: readonly ListedPlugin[] }).plugins;
}

async function configuration(t: TestContext, plugin: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-configured-plugin-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'repometry.config.json'), JSON.stringify({ plugins: [plugin] }));
  return { directory, run: (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' }) };
}

test('plugins lists configured languages and effective file claims before running any tools', async t => {
  const { run } = await configuration(t, fixture);
  const configured = run('plugins');
  assert.equal(configured.status, 0, configured.stderr);
  const list = entries(configured.stdout);
  assert.deepEqual(list.find(entry => entry.id === 'fixture'), {
    id: 'fixture', version: '1.0.0', kinds: ['language'], claims: { extensions: ['.fixture'] },
    providesLanguages: [{ id: 'fixture', label: 'Fixture', color: '#123456', extensions: ['.fixture'] }],
  });
  assert.ok(list.find(entry => entry.id === 'babel-syntax')?.providesLanguages?.some(language => language.id === 'typescript'));
  const builtin = run('plugins', '--no-config');
  assert.equal(builtin.status, 0, builtin.stderr);
  assert.ok(entries(builtin.stdout).every(entry => entry.id !== 'fixture'));
});

test('invalid process plugin declarations name the field that needs correction', async t => {
  const invalid = [
    [{ ...fixture, image: 'node:26-alpine' }, 'image'],
    [{ ...fixture, command: [] }, 'command'],
    [{ ...fixture, limits: { pidsLimit: 0 } }, 'pidsLimit'],
  ] as const;
  for (const [plugin, field] of invalid) {
    const { run } = await configuration(t, plugin);
    const result = run('plugins');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp('plugins/0/(?:limits/)?' + field));
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
    id: fixture.id, version: fixture.version, api: pluginApi, kinds: ['language'], tools: fixture.tools, claims: fixture.claims,
    providesLanguages: [{ ...fixture.providesLanguages[0]!, extensions: ['.fixture'] }],
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
