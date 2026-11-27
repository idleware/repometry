import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCoverageFiles } from '../../main/ts/api/import/lcov-files.js';
import { readInputs } from '../../main/ts/cli/imports.js';
import { sourceLineCounts, workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { mapCoverage } from '../../main/ts/plugins/coverage/coverage.js';

const source = Buffer.from('package example\n\nfunc Run() {\n\tstep()\n\tmaybe()\n}\n');

test('reads repeatable Go coverprofile imports alongside LCOV and finding inputs', () => {
  const root = process.cwd();
  const input = readInputs(root, ['go-cover=one.out', 'lcov=report.info', 'go-cover=two.out', 'eslint=eslint.json']);
  assert.deepEqual(input, { lcov: [join(root, 'report.info')], goCover: [join(root, 'one.out'), join(root, 'two.out')],
    cobertura: undefined, findings: [{ format: 'eslint', category: 'lint', file: join(root, 'eslint.json') }] });
});

test('projects Go profile blocks into existing LCOV hit aggregation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  const atomic = join(root, 'atomic.out');
  const set = join(root, 'set.out');
  const lcov = join(root, 'coverage.info');
  await Promise.all([
    writeFile(join(root, 'go.mod'), 'module example.org/project\n'),
    writeFile(join(root, 'app/go.mod'), 'module "test.example/app/v2" // nested module\n'),
    writeFile(atomic, 'mode: atomic\ntest.example/app/v2/run.go:3.4,5.1 2 2\ntest.example/app/v2/run.go:3.4,5.1 2 3\n'
      + 'test.example/app/v2/run.go:4.7,4.8 1 1\ntest.example/app/v2/run.go:5.2,6.1 1 0\n'
      + 'test.example/app/v2/run.go:6.1,6.2 0 1\n'),
    writeFile(set, `mode: set\r\n${join(root, 'app/run.go')}:5.2,5.8 1 1\r\nexample.org/project/run.go:3.4,4.1 1 0\r\n`),
    writeFile(lcov, 'SF:app/run.go\nDA:4,1\nend_of_record\n'),
  ]);
  const snapshot = workingSnapshot(['app/run.go', 'run.go'].map(path => ({ path, bytes: source })));
  const context = { root, snapshot };
  const inputs = { lcov, goCover: [atomic, set] };
  const { text, inputDigests } = await readCoverageFiles(inputs, context);
  assert.deepEqual(await readCoverageFiles({ lcov, goCover: [set, atomic] }, context), { text, inputDigests });
  assert.equal(inputDigests.length, 3);
  const coverage = mapCoverage({ root, text, sourceLines: sourceLineCounts(snapshot.files) });
  assert.deepEqual([...coverage.gaps], []);
  assert.deepEqual(coverage.files.get('app/run.go'), new Map([[3, 5], [4, 6], [5, 1]]));
  assert.deepEqual(coverage.files.get('run.go'), new Map([[3, 0]]));
  assert.equal(coverage.branches.size, 0);
  assert.equal(coverage.functions.size, 0);
});

test('leaves unqualified paths unmapped when they match only by basename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'coverage.out');
  await writeFile(profile, 'mode: count\nmissing.example/module/run.go:3.4,4.1 1 1\na/run.go:3.4,4.1 1 1\n');
  const snapshot = workingSnapshot(['a/run.go', 'b/run.go'].map(path => ({ path, bytes: source })));
  const { text } = await readCoverageFiles({ goCover: profile }, { root, snapshot });
  const coverage = mapCoverage({ root, text, sourceLines: sourceLineCounts(snapshot.files) });
  assert.deepEqual([...coverage.files], [['a/run.go', new Map([[3, 1]])]]);
  assert.deepEqual([...coverage.gaps.keys()], ['missing.example/module/run.go']);
});

test('rejects invalid Go block coordinates before emitting LCOV', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'malformed.out');
  await writeFile(profile, 'mode: set\nrun.go:4.3,3.1 1 1\n');
  const snapshot = workingSnapshot([{ path: 'run.go', bytes: source }]);
  await assert.rejects(() => readCoverageFiles({ goCover: profile }, { root, snapshot }), /Go coverprofile.*line 2/);
});

test('rejects a module path that resolves to multiple repository files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-go-cover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['a', 'b'].map(directory => mkdir(join(root, directory))));
  const profile = join(root, 'coverage.out');
  await Promise.all([
    writeFile(profile, 'mode: atomic\nexample.org/app/run.go:3.4,4.1 1 1\n'),
    ...['a', 'b'].map(directory => writeFile(join(root, directory, 'go.mod'), 'module example.org/app\n')),
  ]);
  const snapshot = workingSnapshot(['a/run.go', 'b/run.go'].map(path => ({ path, bytes: source })));
  await assert.rejects(() => readCoverageFiles({ goCover: profile }, { root, snapshot }),
    /Ambiguous Go coverprofile source.*a\/run.go, b\/run.go/);
});
