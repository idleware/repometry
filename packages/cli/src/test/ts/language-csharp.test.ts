import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import { readReport } from '../../main/ts/report/json/validation/report.js';
import { defaultCli } from './helpers/wasm-plugin.js';

const source = [
  '// File header',
  'class Fixture {',
  '  static int Wrong(int value) {',
  '    // Kept in the whole-file comment count',
  '    if (value > ) return 1;',
  '    return 0;',
  '  }',
  '  static int Nearby(int value) {',
  '    return value > 0 ? value : 0;',
  '  }',
  '}',
].join('\n');

test('C# is opt-in and saved recovery diagnostics do not fail an inspection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-csharp-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = join(directory, '.repometry');
  const config = join(directory, '.repometry.json');
  await Promise.all([
    writeFile(join(directory, 'main.js'), 'export const sample = 1;\n'),
    writeFile(join(directory, 'Fixture.cs'), source),
    writeFile(config, JSON.stringify({ plugins: ['@repometry/language-csharp'] })),
  ]);
  const run = (binary: string, ...args: string[]) => spawnSync(process.execPath, [binary, ...args,
    '--repo', directory, '--store', store], { encoding: 'utf8' });
  const entry = findPackageJSON('@repometry/all', import.meta.url);
  assert.ok(entry);
  const all = fileURLToPath(new URL('target/main/ts/cli/main.js', pathToFileURL(entry)));
  for (const binary of [defaultCli, all]) {
    const result = run(binary, 'analyze', '--working-tree', '--no-config');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).scope, { files: 1, parsed: 1 });
    assert.match(result.stderr, /@repometry\/language-csharp/);
  }
  const inspected = run(defaultCli, 'analyze', '--working-tree', '--config', config);
  assert.equal(inspected.status, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.scope, { files: 2, parsed: 2, recovered: 1 });
  const displayed = run(defaultCli, 'show', result.subject.id);
  assert.equal(displayed.status, 0, displayed.stderr);
  const report = readReport(JSON.parse(displayed.stdout));
  assert.deepEqual(report.scope, result.scope);
  assert.equal(report.status, 'complete');
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]!.operation, 'source/recovered');
  assert.equal(report.diagnostics[0]!.path, 'Fixture.cs');
  assert.match(report.diagnostics[0]!.message, /line 5, column \d+. Declarations omitted: 2\./);
  const own = report.measurements.filter(row => row.path === 'Fixture.cs');
  assert.equal(own.find(row => row.definition === definitions.comments)?.value, 2);
  assert.deepEqual(own.filter(row => row.definition === definitions.complexity && row.target === 'function')
    .map(({ name, line, column, value }) => [name, line, column, value]), [['Fixture.Nearby', 8, 3, 2]]);

  await writeFile(join(directory, 'Rejected.cs'), 'class Rejected { int Wrong() { int x = ; return 0; } }');
  const withRejection = run(defaultCli, 'analyze', '--working-tree', '--config', config);
  assert.notEqual(withRejection.status, 0);
  const degraded = JSON.parse(withRejection.stdout);
  assert.equal(degraded.status, 'partial');
  assert.deepEqual(degraded.scope, { files: 3, parsed: 2, recovered: 1 });
});
