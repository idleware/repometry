import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeGitHubReview } from '../../main/ts/api/gh/github.js';
import type { Finding } from '../../main/ts/core/model/finding.js';
import { pullReviewSchema } from '../../main/ts/core/model/pull-review.js';
import type { PullReview, ReviewedIssue } from '../../main/ts/core/model/pull-review.js';
import { pullReviewMarkdown } from '../../main/ts/report/markdown/pull-review.js';

function finding(path: string, message: string, line?: number, endLine?: number): Finding {
  return { tool: 'repometry', rule: 'function-complexity', category: 'structure', level: 'medium', message, path,
    ...line === undefined ? {} : { line, endLine: endLine ?? line } };
}

function issue(effect: ReviewedIssue['effect'], value: Finding, extra: Partial<ReviewedIssue> = {}): ReviewedIssue {
  return { effect, finding: value, before: null, fixed: false, context: [], debtMinutes: 0, ...extra };
}

function review(issues: readonly ReviewedIssue[], extra: Partial<PullReview> = {}): PullReview {
  return { schema: pullReviewSchema, number: 42, generatedAt: '2026-11-25T00:00:00.000Z', base: 'origin/main',
    mergeBase: 'a'.repeat(40), head: 'b'.repeat(40), changedFiles: 4, verdict: 'failed', issues, debt: { added: 40, removed: 70 },
    coverage: { imported: true, covered: 126, total: 150, percent: 84, uncovered: [], unmapped: [],
      gate: { minimumPercent: 80, minimumLines: 20, status: 'passed' } },
    issueGate: { maximum: 0, count: 2, status: 'failed' }, unmeasured: [],
    notes: [{ message: 'This change edits Repometry settings, which can hide issues from this check.' }], ...extra };
}

const flag = (verdict: string) => '<picture><source media="(prefers-color-scheme: dark)" '
  + `srcset="https://raw.githubusercontent.com/idleware/repometry/master/.github/assets/flag-${verdict}-dark.svg">`
  + `<img src="https://raw.githubusercontent.com/idleware/repometry/master/.github/assets/flag-${verdict}-light.svg" alt="" width="17" height="17">`
  + '</picture>';

const sample = review([
  issue('new', finding('src/cli/main.ts', 'analyzeRange · Cognitive complexity 19 (limit 15)', 120, 188)),
  issue('worsened', finding('src/store/tree.ts', 'File cognitive complexity 61 (limit 50)'), { before: 54 }),
  issue('improved', finding('src/api/parse.ts', 'parse · Cognitive complexity 22 (limit 15)', 40, 77), { before: 22, fixed: true }),
  issue('touched', finding('src/api/read.ts', 'readTree · Cognitive complexity 31 (limit 15)', 88, 140)),
]);

test('a review renders as one Markdown text for the summary and the comment', () => {
  assert.equal(pullReviewMarkdown(sample), [
    '<!-- repometry-review -->',
    `## ${flag('failed')} repometry`,
    '',
    '**Failed** · 1 new · 1 worsened · 1 improved · 1 touched on the lines changed since `origin/main` (`aaaaaaa` → `bbbbbbb`)',
    '',
    '- Changed-line coverage: 84.00% (126 of 150 lines), minimum 80%, passed',
    '- Debt: +40 min added, −70 min removed',
    '- Note: This change edits Repometry settings, which can hide issues from this check.',
    '',
    '### New',
    '',
    '| File | Issue |',
    '| --- | --- |',
    '| <code>src/cli/main.ts:120–188</code> | analyzeRange · Cognitive complexity 19 (limit 15) |',
    '',
    '### Worsened',
    '',
    '| File | Issue |',
    '| --- | --- |',
    '| <code>src/store/tree.ts</code> | File cognitive complexity 61 (limit 50), was 54 |',
    '',
    '<details><summary>Improved (1)</summary>',
    '',
    '| File | Issue |',
    '| --- | --- |',
    '| <code>src/api/parse.ts:40–77</code> | parse · Cognitive complexity 22 (limit 15), fixed |',
    '',
    '</details>',
    '',
    '<details><summary>Touched (1)</summary>',
    '',
    '| File | Issue |',
    '| --- | --- |',
    '| <code>src/api/read.ts:88–140</code> | readTree · Cognitive complexity 31 (limit 15) |',
    '',
    '</details>',
    '',
  ].join('\n'));
});

test('a clean review says so, and unmeasured parts are named', () => {
  const text = pullReviewMarkdown(review([], { verdict: 'unmeasured', debt: { added: 0, removed: 0 }, notes: [],
    coverage: { imported: false, covered: 0, total: 0, percent: null, uncovered: [], unmapped: [], gate: null },
    unmeasured: [{ operation: 'babel-syntax/parse', path: 'src/a.ts', message: 'Unexpected token' }] }));
  assert.match(text, /^\*\*Not measured\*\* · no issues on the lines changed since/m);
  assert.match(text, /^- Coverage not imported$/m);
  assert.match(text, /^- Not measured: babel-syntax\/parse on <code>src\/a\.ts<\/code>: Unexpected token$/m);
  assert.doesNotMatch(text, /Debt/);
});

test('duplicates name their other copies', () => {
  const copy = issue('new', { ...finding('b.ts', 'Identical code in 2 locations', 1, 14), category: 'duplication', rule: 'identical-code' },
    { context: [{ path: 'a.ts', line: 1, endLine: 14 }] });
  assert.match(pullReviewMarkdown(review([copy])), /Identical code in 2 locations, same code as <code>a\.ts:1–14<\/code> \|$/m);
});

test('a huge review stays under the comment size limit and counts what it cut', () => {
  const issues = Array.from({ length: 600 }, (_, index) =>
    issue('new', finding(`src/module-${index}/file-with-a-long-name.ts`, `fn${index} · Cognitive complexity 40 (limit 15) ${'x'.repeat(40)}`, 1)));
  const text = pullReviewMarkdown(review(issues));
  assert.ok(text.length <= 60_000, String(text.length));
  assert.match(text, /\d+ more issues not shown\.\n$/);
  assert.match(text, /^Annotated on the diff: 10 of 600\.$/m);
});

test('GitHub output annotates new and worsened issues and uncovered ranges, at most 10 of each', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const issues = Array.from({ length: 15 }, (_, index) => issue('new', finding('src/code,with%:x.ts', `fn${index} issue`, index + 1)));
  const value = review([...issues, issue('touched', finding('src/a.ts', 'old', 3))], {
    coverage: { imported: true, covered: 10, total: 30, percent: 33.33, unmapped: [],
      uncovered: [{ path: 'src/a.ts', first: 3, last: 5 }], gate: { minimumPercent: 80, minimumLines: 20, status: 'failed' } } });
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const environment = { GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_WORKSPACE: dir };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  process.stderr.write = ((chunk: string) => written.push(String(chunk)) > 0) as typeof process.stderr.write;
  try {
    await writeGitHubReview(value, pullReviewMarkdown(value), dir);
  } finally {
    process.stderr.write = write;
    for (const [key, previous] of Object.entries(saved)) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  const lines = written.join('').split('\n').filter(Boolean);
  assert.equal(lines.filter(line => line.startsWith('::error ')).length, 10);
  assert.ok(lines.includes('::error file=src/code%2Cwith%25%3Ax.ts,line=1,endLine=1,title=Repometry%3A new issue::fn0 issue'), lines[0]);
  assert.deepEqual(lines.filter(line => line.startsWith('::warning ')),
    ['::warning file=src/a.ts,line=3,endLine=5,title=Repometry%3A not covered::Changed lines 3–5 are not covered']);
  assert.match(await readFile(join(dir, 'summary'), 'utf8'), /^Annotated on the diff: 10 of 15\.$/m);
});

test('changed files without coverage are counted in one line', () => {
  const unmapped = Array.from({ length: 5 }, (_, index) => ({ path: `src/test/t${index}.ts`, reason: 'Changed file has no LCOV source record' }));
  const text = pullReviewMarkdown(review([], { coverage: { ...sample.coverage, unmapped } }));
  assert.match(text, /^- Coverage has no record for 5 changed files: <code>src\/test\/t0\.ts<\/code>, <code>src\/test\/t1\.ts<\/code>, <code>src\/test\/t2\.ts<\/code> and 2 more$/m);
  assert.doesNotMatch(text, /t4\.ts/);
});

test('many unmeasured reasons and notes are cut to a few lines with a count', () => {
  const reasons = Array.from({ length: 700 }, (_, index) => ({ operation: 'babel-syntax/parse', path: `src/broken-${index}.js`,
    message: 'Unexpected token' }));
  const text = pullReviewMarkdown(review([], { verdict: 'unmeasured', unmeasured: reasons, notes: reasons }));
  assert.ok(text.length < 5_000, String(text.length));
  assert.match(text, /^- Not measured: 695 more$/m);
  assert.match(text, /^- Note: 695 more$/m);
});

test('uncovered changed lines are listed, and the annotation cut is counted', () => {
  const uncovered = Array.from({ length: 30 }, (_, index) => ({ path: 'src/a.ts', first: index * 10 + 1, last: index * 10 + 3 }));
  const text = pullReviewMarkdown(review([], { coverage: { ...sample.coverage, uncovered } }));
  assert.match(text, /^<details><summary>Changed lines without coverage \(30\)<\/summary>$/m);
  assert.match(text, /^\| <code>src\/a\.ts:291–293<\/code> \|$/m);
  assert.match(text, /^Annotated on the diff: 10 of 30 uncovered ranges\.$/m);
});

test('a change without changed files says so', () => {
  const text = pullReviewMarkdown(review([], { changedFiles: 0, verdict: 'passed', debt: { added: 0, removed: 0 }, notes: [] }));
  assert.match(text, /^\*\*Passed\*\* · no changes since `origin\/main`/m);
});

test('a cut keeps the order of importance, and a long issue is shortened rather than dropped', () => {
  const long = issue('new', { ...finding('src/key.ts', `Private key ${'x'.repeat(70_000)}`, 1), category: 'secret' });
  const later = Array.from({ length: 3 }, (_, index) => issue('touched', finding(`src/t${index}.ts`, 'old', 1)));
  const text = pullReviewMarkdown(review([long, ...later]));
  assert.ok(text.length <= 60_000);
  assert.match(text, /^\| <code>src\/key\.ts:1<\/code> \| Private key x+… \|$/m);
  assert.match(text, /src\/t2\.ts/);
});

test('the heading is the verdict flag and the name, without the pull request number', () => {
  const heading = (value: PullReview) => pullReviewMarkdown(value).split('\n')[1];
  assert.equal(heading(review([], { verdict: 'passed' })), `## ${flag('passed')} repometry`);
  assert.equal(heading(review([], { verdict: 'unmeasured', number: null })), '## repometry');
  assert.equal(pullReviewMarkdown(review([])).split('\n')[0], '<!-- repometry-review -->');
});
