import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DockerToolRunner } from '../../main/ts/api/process/docker-tool-runner.js';

const image = process.env.REPOMETRY_TOOL_TEST_IMAGE;
const invocation = { argv: ['node', '--version'], files: [], timeoutMs: 5_000, maxOutputBytes: 4_096 };

test('the tool runner rejects paths outside the snapshot and invalid limits before launching', async () => {
  const runner = new DockerToolRunner('local-analyzer');
  await assert.rejects(runner.run({ ...invocation, files: [{ path: '../outside.txt', bytes: Buffer.from('x') }] }), /snapshot path/);
  await assert.rejects(runner.run({ ...invocation, timeoutMs: 0 }), /timeout/);
  await assert.rejects(runner.run({ ...invocation, maxOutputBytes: 0 }), /output limit/);
});

test('Docker tools receive stdin and read-only source bytes without outbound networking', { skip: !image }, async () => {
  const runner = new DockerToolRunner(image!, { memoryBytes: 256 * 1024 * 1024, pidsLimit: 32 });
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import net from 'node:net';
    import os from 'node:os';
    assert.equal(fs.readFileSync('source/file.txt', 'utf8'), 'source');
    assert.throws(() => fs.writeFileSync('source/file.txt', 'changed'), { code: 'EROFS' });
    assert.equal(process.env.HOME, '/tmp');
    fs.writeFileSync('/tmp/fixture-cache', 'cached');
    assert.equal(fs.readFileSync('/tmp/fixture-cache', 'utf8'), 'cached');
    assert.deepEqual(Object.values(os.networkInterfaces()).flat().filter(entry => !entry.internal), []);
    assert.equal(process.env.REPOMETRY_TOOL_TEST_IMAGE, undefined);
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '192.0.2.1', port: 80 });
      socket.once('connect', () => { socket.destroy(); reject(Error('unexpected network access')); });
      socket.once('error', error => error.code === 'ENETUNREACH' ? resolve() : reject(error));
    });
    process.stdout.write(fs.readFileSync(0));
    process.stderr.write('tool warning');
    process.exitCode = 7;
  `;
  const result = await runner.run({ ...invocation, argv: ['node', '--input-type=module', '-e', script],
    files: [{ path: 'source/file.txt', bytes: Buffer.from('source') }], stdin: Buffer.from('tool input') });
  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.from(result.stdout).toString(), 'tool input');
  assert.equal(Buffer.from(result.stderr).toString(), 'tool warning');
});

test('a missing Docker image is reported as a startup failure', { skip: !image }, async () => {
  const runner = new DockerToolRunner(`repometry-fixture-missing:${randomUUID()}`);
  await assert.rejects(runner.run(invocation), /Docker could not start the tool.*125/);
});

test('Docker tools are stopped when they exceed the deadline or output limit', { skip: !image }, async () => {
  const runner = new DockerToolRunner(image!);
  await assert.rejects(runner.run({ ...invocation, argv: ['node', '-e', 'setInterval(() => {}, 100)'], timeoutMs: 1_000 }), /timed out/);
  await assert.rejects(runner.run({ ...invocation, argv: ['node', '-e', 'process.stdout.write("x".repeat(8192))'] }), /output limit/);
});
