import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeWorkerInput, encodeWorkerInput } from '../../main/ts/api/worker/worker-protocol.js';
import { analyzeSnapshot, inspect } from '../../main/ts/compose/inspect.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';

test('the worker delivers claimed text to the matching inspections without attempting language analysis', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-claims-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflows = join(directory, '.github', 'workflows');
  await mkdir(workflows, { recursive: true });
  const workflow = 'name: test\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: example/checkout@v1\n';
  await writeFile(join(workflows, 'ci.yaml'), workflow);
  await writeFile(join(workflows, 'binary.yaml'), '\0' + workflow);
  await writeFile(join(workflows, 'large.yaml'), Buffer.alloc(1024 * 1024 + 1, 'x'));
  await writeFile(join(directory, 'source.js'), 'export const value = 1;\n');

  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true } }, async input => {
    const transported = decodeWorkerInput(JSON.parse(encodeWorkerInput(input)));
    assert.deepEqual(transported.snapshot.files.map(file => file.path).sort(), ['.github/workflows/ci.yaml', 'source.js']);
    return analyzeSnapshot(transported);
  });
  assert.deepEqual(report.scope, { files: 1, parsed: 1 });
  assert.ok(report.findings?.some(finding => finding.path === '.github/workflows/ci.yaml' && finding.tool === 'actions-security'));
  assert.ok(report.pluginData?.inventory?.some(file => file.path === '.github/workflows/ci.yaml' && file.analysed));
  assert.deepEqual(report.diagnostics.map(({ path, operation }) => [path, operation]), [['.github/workflows/large.yaml', 'source/claims']]);
  assert.ok((commitSummary(report).counts?.security?.medium ?? 0) > 0);
});

test('scan-only claims preserve findings without marking files analysed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-scan-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'README.md'), '# Example\n');
  await writeFile(join(directory, '.env'), 'APP_PORT=3030\n');

  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true } }, analyzeSnapshot);

  assert.equal(report.status, 'complete');
  assert.ok(report.findings?.some(finding => finding.path === '.env' && finding.tool === 'secrets'));
  assert.deepEqual(report.pluginData?.inventory?.map(({ path, analysed }) => [path, analysed]), [
    ['.env', false], ['README.md', false],
  ]);
});
