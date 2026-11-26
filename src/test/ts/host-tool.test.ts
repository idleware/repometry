import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { hostToolPath, probeHostTool } from '../../main/ts/api/process/host-tool.js';

test('a go version check leaves nothing in the temporary folder, also after go\'s own processes end', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'repometry-host-tool-test-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: temporary, TEMP: temporary });
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  });

  const tool = probeHostTool('go', ['version'], hostToolPath());
  if ('unavailableReason' in tool) {
    t.skip(tool.unavailableReason);
    return;
  }
  // go starts a telemetry process that outlives the command and writes to its home a moment later.
  for (let waited = 0; waited < 2_500; waited += 50) {
    assert.deepEqual(await readdir(temporary), []);
    await delay(50);
  }
});
