import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerToolRunner } from '../../main/ts/api/process/docker-tool-runner.js';
import { processPlugin, processPluginProtocol } from '../../main/ts/api/process/plugin.js';
import type { ProcessPluginManifest } from '../../main/ts/api/process/plugin.js';
import { inspect } from '../../main/ts/compose/inspect.js';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import { measurements } from '@repometry/core/internal/model/measurement.js';
import { digest, sourceFile, sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import type { ToolRunner } from '@repometry/core/internal/ports/tool-runner.js';

const metric = { id: 'fixture.process-count/v1', label: 'Process count', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none' } as const;
const fileText = 'process sample';
const filePath = 'input.txt';
const observation = { definition: metric.id, target: 'file', path: filePath, value: 2 };
const manifest: ProcessPluginManifest = {
  id: 'fixture-process', api: pluginApi, version: '1.0.0', kinds: ['analysis'], claims: { extensions: ['.txt'] },
  tools: { 'fixture-tool': '1.1.0' }, settings: { factor: 2 },
  config: { type: 'object', properties: { factor: { const: 2 } }, required: ['factor'] },
  produces: [{ contract: measurements.id, persistence: 'report', metrics: [metric] }],
  operations: [{ id: 'count', role: 'inspection', inputs: { source: sourceFile }, output: measurements,
    argv: ['fixture-tool'], timeoutMs: 5_000, maxOutputBytes: 4_096 }],
};

async function inspectFixture(t: { after(callback: () => Promise<void>): void }, runner: ToolRunner, plugin = manifest,
  sources: readonly (readonly [string, string])[] = [[filePath, fileText]]) {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-process-fixture-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await Promise.all(sources.map(([path, value]) => writeFile(join(directory, path), value)));
  return inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: [processPlugin(plugin, runner)] });
}

test('process operations receive file identities and settings, and preserve diagnostics and results', async t => {
  const location = { path: filePath, sha256: digest(fileText) };
  const warning = { kind: 'diagnostic', severity: 'warning', message: 'Partial fixture analysis' };
  const product = { kind: 'product', contract: measurements.id, value: [observation] };
  const report = await inspectFixture(t, { network: 'none', async run(request) {
    assert.deepEqual(request.argv, ['fixture-tool']);
    assert.deepEqual(request.files.map(file => file.path), [filePath]);
    assert.equal(Buffer.from(request.files[0]!.bytes).toString(), fileText);
    assert.deepEqual(JSON.parse(Buffer.from(request.stdin!).toString()), {
      protocol: processPluginProtocol, operation: 'fixture-process/count', settings: { factor: 2 },
      files: [location], inputs: { source: { contract: sourceFile.id, file: location } },
    });
    const records = [
      { kind: 'diagnostic', severity: 'info', message: 'Fixture started' },
      { kind: 'diagnostic', message: 'Fixture output follows' },
      warning, product,
    ];
    return { exitCode: 0, stdout: Buffer.from(records.map(record => JSON.stringify(record)).join('\n')), stderr: Buffer.alloc(0) };
  } });
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.measurements.find(row => row.definition === metric.id), observation);
  assert.deepEqual(report.diagnostics, [{ operation: 'fixture-process/count', path: filePath, state: 'partial', message: warning.message }]);
  const plugins = report.appliedConfig.plugins;
  assert.ok(Array.isArray(plugins));
  assert.deepEqual(plugins.find(plugin => plugin.id === manifest.id)?.settings, { factor: 2 });
});

test('process operations reject a result whose contract differs from the declared output', async t => {
  const report = await inspectFixture(t, { network: 'none', async run() {
    return { exitCode: 0, stdout: Buffer.from('{"kind":"product","contract":"wrong","value":[] }\n'), stderr: Buffer.alloc(0) };
  } });
  assert.equal(report.status, 'partial');
  assert.match(report.diagnostics[0]?.message ?? '', /declared product/);
  assert.equal(report.measurements.some(row => row.definition === metric.id), false);
});

test('a process failure includes bounded stderr context without credential assignments', async t => {
  const report = await inspectFixture(t, { network: 'none', async run() {
    return { exitCode: 3, stdout: Buffer.alloc(0),
      stderr: Buffer.from('Early progress\nReading fixture\nTOKEN=private-fixture-default\nCould not parse build settings\n') };
  } });
  const diagnostic = report.diagnostics[0]?.message ?? '';
  assert.match(diagnostic, /exited with code 3/);
  assert.match(diagnostic, /Could not parse build settings/);
  assert.doesNotMatch(diagnostic, /private-fixture-default|Early progress/);
});

test('a repository operation runs once with the complete set of claimed files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-process-repository-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const sources = [['a.txt', 'one'], ['b.txt', 'second'], ['skip.txt', 'excluded'], ['other.md', 'unclaimed']] as const;
  await Promise.all(sources.map(([path, value]) => writeFile(join(directory, path), value)));
  const operation = { ...manifest.operations[0]!, scope: 'repository' as const, inputs: { files: sourceFiles } };
  const plugin = { ...manifest, operations: [operation] };
  let calls = 0;
  const wrapped = processPlugin(plugin, { network: 'none', async run(request) {
    calls++;
    assert.deepEqual(request.files.map(file => file.path), ['a.txt', 'b.txt']);
    const input = JSON.parse(Buffer.from(request.stdin!).toString());
    const references = request.files.map(file => ({ path: file.path, sha256: digest(file.bytes) }));
    assert.deepEqual(input.files, references);
    assert.deepEqual(input.inputs.files, { contract: sourceFiles.id, files: references });
    const values = request.files.map(file => ({ ...observation, path: file.path, value: file.bytes.length }));
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ kind: 'product', contract: measurements.id, value: values })),
      stderr: Buffer.alloc(0) };
  } });

  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true },
    exclude: ['skip.txt'], plugins: [wrapped] });
  assert.equal(calls, 1);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.measurements.filter(row => row.definition === metric.id).map(row => [row.path, row.value]), [
    ['a.txt', 3], ['b.txt', 6],
  ]);
  assert.deepEqual(report.pluginData?.inventory?.map(({ path, analysed }) => [path, analysed]), [
    ['a.txt', true], ['b.txt', true], ['other.md', false],
  ]);
});

const image = process.env.REPOMETRY_TOOL_TEST_IMAGE;
test('a repository-scoped JSON Lines process plugin returns both file results through Docker', { skip: !image }, async t => {
  const source = `
    const fs = require('node:fs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const value = input.inputs.files.files.map(({ path }) => ({
      definition: ${JSON.stringify(metric.id)}, target: 'file', path,
      value: fs.readFileSync(path, 'utf8') ? input.settings.factor : 0,
    }));
    process.stdout.write(JSON.stringify({ kind: 'product', contract: ${JSON.stringify(measurements.id)}, value }) + '\\n');
  `;
  const plugin = { ...manifest, operations: [{ ...manifest.operations[0]!, argv: ['node', '-e', source],
    scope: 'repository' as const, inputs: { files: sourceFiles } }] };
  const report = await inspectFixture(t, new DockerToolRunner(image!), plugin, [[filePath, fileText], ['second.txt', 'second']]);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.measurements.filter(row => row.definition === metric.id), [observation, { ...observation, path: 'second.txt' }]);
});
