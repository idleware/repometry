import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { serialize } from 'node:v8';
import { inspect } from '../../main/ts/compose/inspect.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract, Plugin } from '../../main/ts/core/engine/plugin.js';
import { measurements } from '../../main/ts/core/model/measurement.js';
import { sourceFile } from '../../main/ts/core/model/snapshot.js';
import { LocalOperationCache } from '../../main/ts/report/json/store/operation-cache.js';

test('inspection reuses validated cached products only for the same inputs, settings, and toolchain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-operation-cache-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const output = join(directory, '.repometry');
  const cacheDirectory = join(output, 'cache');
  const source = join(directory, 'sample.txt');
  await writeFile(source, 'alpha');
  const byteCount: DataContract<number> = { id: 'fixture.bytes/v1', accepts: (value): value is number => typeof value === 'number' };
  const metric = { id: 'fixture.cached-bytes/v1', label: 'Bytes', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none' } as const;
  let calls = 0;
  const plugin: Plugin = {
    id: 'fixture-cache', version: '1.0.0', api: pluginApi, kinds: ['analysis'], claims: { extensions: ['.txt'] },
    tools: { fixture: '1' },
    produces: [
      { contract: byteCount.id, persistence: 'cache', schema: { type: 'integer', minimum: 0 } },
      { contract: measurements.id, persistence: 'report', metrics: [metric] },
    ],
    operations: [{ id: 'read', role: 'provider', inputs: { file: sourceFile }, output: byteCount,
      execute(input) { calls++; return input.read('file', sourceFile).bytes.length; } },
    { id: 'count', role: 'inspection', inputs: { file: sourceFile, bytes: byteCount }, output: measurements,
      execute: input => [{ definition: metric.id, target: 'file', path: input.read('file', sourceFile).path,
        value: input.read('bytes', byteCount) }] }],
  };

  async function run(configurationDigest = 'one', current = plugin) {
    const report = await inspect({ directory, output, source: { workingTree: true }, plugins: [current],
      operationCache: { store: new LocalOperationCache(cacheDirectory), configurationDigest } });
    assert.equal(report.status, 'complete');
    assert.equal(report.pluginData?.products[byteCount.id], undefined);
    return report.measurements.find(row => row.definition === metric.id)?.value;
  }

  assert.equal(await run(), 5);
  assert.equal(await run(), 5);
  assert.equal(calls, 1);
  const entry = (await readdir(cacheDirectory, { recursive: true })).find(path => /^[a-f0-9]{64}$/.test(basename(path)));
  assert.ok(entry);
  await writeFile(join(cacheDirectory, entry), serialize({ contract: byteCount.id, value: -1 }));
  assert.equal(await run(), 5);
  assert.equal(calls, 2);
  assert.equal(await run('two'), 5);
  assert.equal(await run('two', { ...plugin, tools: { fixture: '2' } }), 5);
  assert.equal(await run('two', { ...plugin, version: '2.0.0' }), 5);
  await writeFile(source, 'bravo');
  assert.equal(await run('two'), 5);
  assert.equal(calls, 6);
});
