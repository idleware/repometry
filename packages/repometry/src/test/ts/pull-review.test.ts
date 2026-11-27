import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FileLineChange, LineChanges } from '@repometry/core/internal/model/changes.js';
import type { Finding } from '@repometry/core/internal/model/finding.js';
import type { Diagnostic, Report } from '@repometry/core/internal/model/report.js';
import { reportSchema } from '@repometry/core/internal/model/report.js';
import { diffCoverageSchema } from '@repometry/core/internal/usecases/diff-coverage.js';
import type { DiffCoverageReport } from '@repometry/core/internal/usecases/diff-coverage.js';
import { projectReview, reviewExitCode, reviewReason } from '@repometry/core/internal/usecases/review.js';
import type { ReviewInputs } from '@repometry/core/internal/usecases/review.js';
import { listPullReviews } from '../../main/ts/report/json/store/pull-review-store.js';

const baseId = 'a'.repeat(40);
const headId = 'b'.repeat(40);
const sources = { base: { line: () => 'code' }, head: { line: () => 'code' } };

function complexity(value: number, line = 10): Finding {
  return { tool: 'repometry', rule: 'function-complexity', category: 'structure', level: 'medium',
    message: `run · Cognitive complexity ${value} (limit 15)`, path: 'src/a.ts', line, endLine: line + 20, value, limit: 15,
    anchor: 'run', effortMinutes: (value - 15) * 10 };
}

function report(id: string, findings: readonly Finding[], diagnostics: readonly Diagnostic[] = []): Report {
  return { schema: reportSchema, subject: { kind: 'commit', id }, generatedAt: '2026-11-25T00:00:00.000Z', appliedConfig: {},
    definitions: {}, scope: { files: 1, parsed: 1 }, status: 'complete', measurements: [], diagnostics, findings };
}

const edit = (path: string, first = 15, last = first): FileLineChange =>
  ({ path, previous: path, added: [{ first, last }], removed: [{ first, last }], whole: false, hunks: [] });

function inputs(base: readonly Finding[], head: readonly Finding[], overrides: Partial<ReviewInputs> = {}): ReviewInputs {
  const changes: LineChanges = { files: [edit('src/a.ts')] };
  return { requestedBase: baseId, base: report(baseId, base), head: report(headId, head), changes, sources, coverage: null,
    settingsChanged: false, ...overrides };
}

function coverage(covered: number, total: number, uncovered: readonly number[] = []): NonNullable<ReviewInputs['coverage']> {
  const report: DiffCoverageReport = { schema: diffCoverageSchema, requestedBase: baseId, base: baseId, head: headId,
    generatedAt: '2026-11-25T00:00:00.000Z', appliedConfig: {}, status: 'complete', covered, total,
    percent: total === 0 ? null : covered / total * 100, files: [], gaps: [], decision: null };
  return { report, uncovered: uncovered.length ? [{ path: 'src/a.ts', lines: uncovered }] : [] };
}

test('a worsened issue fails the build with exit 3', () => {
  const review = projectReview({}, inputs([complexity(17)], [complexity(19)]));
  assert.equal(review.schema, 'urn:repometry:schema:pull-review:2');
  assert.deepEqual(review.issues.map(issue => issue.effect), ['worsened']);
  assert.deepEqual(review.issueGate, { maximum: 0, count: 1, status: 'failed' });
  assert.equal(review.verdict, 'failed');
  assert.equal(reviewExitCode(review), 3);
  assert.deepEqual(review.debt, { added: 20, removed: 0 });
});

test('touched and improved issues alone pass', () => {
  const touched = projectReview({}, inputs([complexity(31)], [complexity(31)]));
  assert.deepEqual(touched.issues.map(issue => issue.effect), ['touched']);
  assert.equal(reviewExitCode(touched), 0);
  const improved = projectReview({}, inputs([complexity(22)], [complexity(18)]));
  assert.deepEqual(improved.issues.map(issue => issue.effect), ['improved']);
  assert.equal(improved.verdict, 'passed');
  assert.equal(reviewExitCode(improved), 0);
});

test('maxNewIssues allows that many new and worsened issues', () => {
  const review = projectReview({ maxNewIssues: 1 }, inputs([], [complexity(19)]));
  assert.deepEqual(review.issueGate, { maximum: 1, count: 1, status: 'passed' });
  assert.equal(reviewExitCode(review), 0);
});

test('changed-line coverage below the minimum fails from 20 measured lines', () => {
  const failed = projectReview({}, inputs([], [], { coverage: coverage(21, 30) }));
  assert.deepEqual(failed.coverage.gate, { minimumPercent: 80, minimumLines: 20, status: 'failed' });
  assert.equal(reviewExitCode(failed), 3);
  const small = projectReview({}, inputs([], [], { coverage: coverage(7, 10) }));
  assert.equal(small.coverage.gate?.status, 'not-applicable');
  assert.equal(reviewExitCode(small), 0);
  const custom = projectReview({ minimumPercent: 70, minimumLines: 5 }, inputs([], [], { coverage: coverage(7, 10) }));
  assert.deepEqual(custom.coverage.gate, { minimumPercent: 70, minimumLines: 5, status: 'passed' });
  const absent = projectReview({}, inputs([], []));
  assert.equal(absent.coverage.imported, false);
  assert.equal(absent.coverage.gate, null);
});

test('a coverage minimum without coverage throws', () => {
  assert.throws(() => projectReview({ minimumPercent: 80 }, inputs([], [])),
    { message: 'Minimum changed-line coverage requires --import lcov=PATH, go-cover=PATH or cobertura=PATH' });
});

test('an operation failing on the head only leaves the review unmeasured', () => {
  const failure: Diagnostic = { operation: 'duplication/clones', state: 'failed', message: 'Duplication failed' };
  const review = projectReview({}, inputs([], [], { head: report(headId, [], [failure]) }));
  assert.deepEqual(review.unmeasured, [{ operation: 'duplication/clones', message: 'Duplication failed' }]);
  assert.equal(review.verdict, 'unmeasured');
  assert.equal(reviewExitCode(review), 2);
});

test('a failed coverage import and host operations do not leave the review unmeasured', () => {
  const diagnostics: Diagnostic[] = [{ operation: 'lcov/import', state: 'failed', message: 'Unreadable LCOV' },
    { operation: 'git/churn', state: 'failed', message: 'No history' },
    { operation: 'lint/check', state: 'failed', message: 'Lint failed' }];
  // The coverage import is the operation whose stored record reads the host's coverage input.
  const operations = [{ key: 'lcov/import', inputs: { report: { external: 'lcov' } } }, { key: 'lint/check', inputs: { source: { external: 'file' } } }];
  const head = { ...report(headId, [], diagnostics), appliedConfig: { operations } };
  assert.deepEqual(projectReview({}, inputs([], [], { head })).unmeasured, [{ operation: 'lint/check', message: 'Lint failed' }]);
});

test('a failed operation of any other coverage plugin leaves the review unmeasured', () => {
  const diagnostics: Diagnostic[] = [{ operation: 'lcov/lines', state: 'failed', message: 'No lines' },
    { operation: 'cover2/read', state: 'failed', message: 'Unreadable report' }];
  const operations = [{ key: 'lcov/import', inputs: { report: { external: 'lcov' } } },
    { key: 'lcov/lines', inputs: { coverage: { operation: 'lcov/import' } } }, { key: 'cover2/read', inputs: { source: { external: 'file' } } }];
  const plugins = [{ id: 'lcov', kinds: ['coverage', 'import'] }, { id: 'cover2', kinds: ['coverage'] }];
  const head = { ...report(headId, [], diagnostics), appliedConfig: { plugins, operations } };
  assert.deepEqual(projectReview({}, inputs([], [], { head })).unmeasured.map(({ operation }) => operation), ['lcov/lines', 'cover2/read']);
});

test('a parse failure on a changed head file leaves the review unmeasured', () => {
  const failure: Diagnostic = { operation: 'babel-syntax/parse', state: 'failed', message: 'Unexpected token', path: 'src/a.ts' };
  const review = projectReview({}, inputs([], [], { head: report(headId, [], [failure]) }));
  assert.deepEqual(review.unmeasured, [{ operation: 'babel-syntax/parse', message: 'Unexpected token', path: 'src/a.ts' }]);
  assert.equal(reviewExitCode(review), 2);
});

test('a failure on both sides, a file over 1 MiB and churn are notes, not failures', () => {
  const both: Diagnostic = { operation: 'osv/scan', state: 'failed', message: 'Scanner failed' };
  const large: Diagnostic = { operation: 'source/claims', state: 'partial', path: 'src/a.ts',
    message: 'Plugin inspection skipped a file larger than 1 MiB' };
  const churn: Diagnostic = { operation: 'git/churn', state: 'partial', message: 'Shallow checkout' };
  const review = projectReview({}, inputs([], [], { base: report(baseId, [], [both]), head: report(headId, [], [both, large, churn]) }));
  assert.deepEqual(review.unmeasured, []);
  assert.deepEqual(review.notes, [
    { operation: 'osv/scan', message: 'Scanner failed' },
    { operation: 'source/claims', path: 'src/a.ts', message: 'Plugin inspection skipped a file larger than 1 MiB' },
  ]);
  assert.equal(reviewExitCode(review), 0);
});

test('a settings change adds a note', () => {
  const review = projectReview({}, inputs([], [], { settingsChanged: true }));
  assert.deepEqual(review.notes, [{ message: 'This change edits Repometry settings, which can hide issues from this check.' }]);
});

test('uncovered changed lines are merged into ranges', () => {
  const review = projectReview({}, inputs([], [], { coverage: coverage(26, 30, [3, 4, 5, 9]) }));
  assert.deepEqual(review.coverage.uncovered, [{ path: 'src/a.ts', first: 3, last: 5 }, { path: 'src/a.ts', first: 9, last: 9 }]);
  assert.equal(review.coverage.percent, 26 / 30 * 100);
});

test('the review names its pull request and commits', () => {
  const review = projectReview({ number: 42 }, inputs([], [], { requestedBase: 'origin/main' }));
  assert.deepEqual([review.number, review.base, review.mergeBase, review.head], [42, 'origin/main', baseId, headId]);
});

test('review files saved before 0.9 still list', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-reviews-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = { schema: 'urn:repometry:schema:pull-review:1', number: 7, generatedAt: '2026-11-20T00:00:00.000Z',
    base: baseId, mergeBase: baseId, head: headId,
    coverage: { base: null, head: null, delta: null, reason: 'reports-unavailable', gate: null },
    diff: { status: 'unavailable', covered: 0, total: 0, percent: null, files: [], gaps: [], excludedPaths: null,
      coverageInputDigest: null, uncovered: [], gate: null },
    findings: { added: null, qualityCount: null, reason: 'reports-unavailable', gate: null } };
  await mkdir(join(dir, 'reviews'));
  await writeFile(join(dir, 'reviews', '7.json'), JSON.stringify(old));
  assert.deepEqual(await listPullReviews(dir), [old]);
});

test('operations blocked by a failure on the same file fold into that failure', () => {
  const failed: Diagnostic = { operation: 'babel-syntax/parse', state: 'failed', message: 'Unexpected token', path: 'src/a.ts' };
  const blocked = ['structure/size', 'structure/complexity', 'maintainability/file'].map((operation): Diagnostic =>
    ({ operation, state: 'blocked', message: 'Unavailable inputs: syntax', path: 'src/a.ts' }));
  const review = projectReview({}, inputs([], [], { head: report(headId, [], [failed, ...blocked]) }));
  assert.deepEqual(review.unmeasured, [{ operation: 'babel-syntax/parse', message: 'Unexpected token', path: 'src/a.ts' }]);
});

test('the review states its reason in one line', () => {
  assert.equal(reviewReason(projectReview({}, inputs([complexity(17)], [complexity(19)]))),
    'Review failed: 1 new or worsened issue on the changed lines, 0 allowed.');
  assert.equal(reviewReason(projectReview({}, inputs([], [], { coverage: coverage(21, 30) }))),
    'Review failed: changed-line coverage 70.00% is under the 80% minimum.');
  const failure: Diagnostic = { operation: 'babel-syntax/parse', state: 'failed', message: 'Unexpected token', path: 'src/a.ts' };
  assert.equal(reviewReason(projectReview({}, inputs([], [], { head: report(headId, [], [failure]) }))),
    'Review not measured: babel-syntax/parse on src/a.ts: Unexpected token.');
  assert.equal(reviewReason(projectReview({}, inputs([], []))), 'Review passed.');
});

test('the review counts the changed files', () => {
  assert.equal(projectReview({}, inputs([], [])).changedFiles, 1);
  assert.equal(projectReview({}, inputs([], [], { changes: { files: [] } })).changedFiles, 0);
});
