import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedRanges, rawChanges } from '../../main/ts/api/git/changes.js';
import type { GitChanges } from '../../main/ts/api/git/changes.js';
import { assessDiffCoverage } from '../../main/ts/core/usecases/diff-coverage-policy.js';
import { execute } from '../../main/ts/core/engine/execute.js';
import { plan } from '../../main/ts/core/engine/plan.js';
import type { Product } from '../../main/ts/core/engine/plugin.js';
import { changesInput } from '../../main/ts/core/model/changes.js';
import { lcovInput } from '../../main/ts/core/model/coverage-input.js';
import type { CoverageInput } from '../../main/ts/core/model/coverage-input.js';
import { diffCoverageResult } from '../../main/ts/core/model/diff-coverage.js';
import { diffCoverage } from '../../main/ts/plugins/coverage/diff-coverage.js';

test('Git changes preserve paths and use only the added side of hunks', () => {
  const old = 'a'.repeat(40);
  const next = 'b'.repeat(40);
  const first = 'src/old\tfile.ts';
  const second = 'src/new\nfile.ts';
  const raw = [`:100644 100644 ${old} ${next} R85`, first, second, ''].join('\0');
  assert.deepEqual(rawChanges(raw), [{ path: second, mode: '100644', oid: next, previous: { path: first, oid: old } }]);
  const patch = '@@ -2,2 +1,0 @@\n-a\u2028@@ -5 +6 @@\n-b\n@@ -9 +7 @@\n-old\n+new\n@@ -14,0 +13,2 @@ function f()\n+next\n+next\n';
  assert.deepEqual(addedRanges(patch), [{ first: 7, last: 7 }, { first: 13, last: 14 }]);
});

test('diff coverage counts distinct LCOV lines within added ranges and reports missing files', async () => {
  const input = { text: 'SF:src/app.ts\nDA:1,4\nDA:2,0\nDA:4,0\nend_of_record\n'
    + 'SF:src/app.ts\nDA:4,2\nend_of_record\nSF:vendor/lib.ts\nDA:9999,1\nend_of_record\n',
  root: '/project', sourceLines: new Map([['src/app.ts', 6], ['src/missing.ts', 1]]),
  excludes: (path: string) => path.startsWith('vendor/') };
  const appRanges = [{ first: 2, last: 2 }, { first: 4, last: 5 }];
  const files = new Map([['src/app.ts', appRanges]]);
  const result = await measure({ files, gaps: new Map() }, input);
  assert.deepEqual(result, { status: 'complete', covered: 1, total: 2, percent: 50,
    files: [{ path: 'src/app.ts', addedLines: 3, covered: 1, total: 2 }], gaps: [], uncovered: [{ path: 'src/app.ts', lines: [2] }] });
  assert.deepEqual(assessDiffCoverage(result, 50), { status: 'passed', minimumPercent: 50 });
  assert.deepEqual(assessDiffCoverage(result, 50.1), { status: 'failed', minimumPercent: 50.1 });
  assert.throws(() => assessDiffCoverage(result, 101), /percentage/);

  files.set('src/missing.ts', [{ first: 1, last: 1 }]);
  const partial = await measure({ files, gaps: new Map() }, input);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.percent, 50);
  assert.deepEqual(partial.files[1], { path: 'src/missing.ts', addedLines: 1, covered: null, total: null });
  assert.deepEqual(assessDiffCoverage(partial, 0), { status: 'indeterminate', minimumPercent: 0 });
  const empty = await measure({ files: new Map(), gaps: new Map() }, input);
  assert.equal(empty.percent, null);
  assert.equal(assessDiffCoverage(empty, 100).status, 'not-applicable');
});

async function measure(changes: GitChanges, coverage: CoverageInput) {
  const operation = 'diff-coverage/measure';
  const tasks = plan({ plugins: [diffCoverage], select: [operation],
    inputs: new Map([['changes', changesInput.id], ['lcov', lcovInput.id]]) });
  const result = await execute(tasks, new Map<string, Product>([
    ['changes', { contract: changesInput.id, value: changes }],
    ['lcov', { contract: lcovInput.id, value: coverage }],
  ]));
  const outcome = result.get(operation);
  assert.ok(outcome?.state === 'completed', JSON.stringify(outcome));
  assert.ok(diffCoverageResult.accepts(outcome.product.value));
  return outcome.product.value;
}
