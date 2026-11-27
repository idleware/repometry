import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileLineChange, LineChanges, LineRange } from '../../main/ts/model/changes.js';
import type { Finding } from '../../main/ts/model/finding.js';
import { classifyIssues, debtEffect } from '../../main/ts/usecases/review-effect.js';
import type { SourceLines } from '../../main/ts/usecases/review-effect.js';

function complexity(path: string, line: number, endLine: number, anchor: string, value: number): Finding {
  return { tool: 'repometry', rule: 'function-complexity', category: 'structure', level: 'medium',
    message: `${anchor} · Cognitive complexity ${value} (limit 15)`, path, line, endLine, value, limit: 15, anchor,
    effortMinutes: (value - 15) * 10 };
}

function duplicate(anchor: string, copies: readonly [string, number, number][]): Finding {
  const [[path, line, endLine], ...rest] = copies as [[string, number, number], ...[string, number, number][]];
  return { tool: 'repometry', rule: 'identical-code', category: 'duplication', level: 'medium',
    message: `Identical code in ${copies.length} locations`, path, line, endLine, value: copies.length, anchor,
    related: rest.map(([path, line, endLine]) => ({ path, line, endLine })), effortMinutes: (copies.length - 1) * 28 };
}

const range = (first: number, last = first): LineRange => ({ first, last });

function edit(path: string, added: readonly LineRange[], removed: readonly LineRange[] = added,
  previous: string | null = path, hunks: FileLineChange['hunks'] = []): FileLineChange {
  return { path, previous, added, removed, whole: false, hunks };
}

const changes = (...files: FileLineChange[]): LineChanges => ({ files });
const none: SourceLines = { line: () => '' };
const sources = { base: none, head: none };
const effects = (issues: ReturnType<typeof classifyIssues>) => issues.map(issue => issue.effect);

test('a value going up on a changed line is worsened', () => {
  const issues = classifyIssues([complexity('a.ts', 10, 30, 'run', 17)], [complexity('a.ts', 10, 31, 'run', 19)],
    changes(edit('a.ts', [range(20)])), sources);
  assert.deepEqual(effects(issues), ['worsened']);
  assert.equal(issues[0]?.before, 17);
  assert.equal(issues[0]?.finding.value, 19);
});

test('a line inserted into a function counts it as changed on the head side only', () => {
  const issues = classifyIssues([complexity('a.ts', 10, 30, 'run', 17)], [complexity('a.ts', 10, 31, 'run', 19)],
    changes(edit('a.ts', [range(20)], [])), sources);
  assert.deepEqual(effects(issues), ['worsened']);
});

test('an unchanged value on a changed line is touched', () => {
  const issues = classifyIssues([complexity('a.ts', 10, 60, 'readTree', 31)], [complexity('a.ts', 10, 60, 'readTree', 31)],
    changes(edit('a.ts', [range(40)])), sources);
  assert.deepEqual(effects(issues), ['touched']);
});

test('an issue away from the changed lines is out of scope', () => {
  const issues = classifyIssues([complexity('a.ts', 50, 60, 'run', 31)], [complexity('a.ts', 50, 60, 'run', 31)],
    changes(edit('a.ts', [range(10)])), sources);
  assert.deepEqual(issues, []);
});

test('a renamed file keeps its issues', () => {
  const issues = classifyIssues([complexity('a.ts', 10, 60, 'run', 31)], [complexity('b.ts', 10, 60, 'run', 31)],
    changes(edit('b.ts', [range(12)], [range(12)], 'a.ts')), sources);
  assert.deepEqual(effects(issues), ['touched']);
});

test('a function moved within its file is not new', () => {
  const issues = classifyIssues([complexity('a.ts', 10, 30, 'run', 20)], [complexity('a.ts', 40, 60, 'run', 20)],
    changes(edit('a.ts', [range(40, 60)], [range(10, 30)])), sources);
  assert.deepEqual(effects(issues), ['touched']);
});

test('an issue without an anchor is matched by the text of its line', () => {
  const lint = (line: number): Finding => ({ tool: 'eslint', rule: 'no-console', category: 'lint', level: 'low',
    message: 'Unexpected console statement', path: 'a.ts', line });
  const text = (lines: Readonly<Record<number, string>>): SourceLines => ({ line: (_path, line) => lines[line] });
  const lines = { base: text({ 5: 'console.log(x);' }), head: text({ 8: '  console.log(x);' }) };
  assert.deepEqual(classifyIssues([lint(5)], [lint(8)], changes(edit('a.ts', [range(1, 3)], [])), lines), []);
  const touched = classifyIssues([lint(5)], [lint(8)], changes(edit('a.ts', [range(1, 3), range(8)], [range(5)])), lines);
  assert.deepEqual(effects(touched), ['touched']);
});

test('a new duplicate shows once, on its changed copy', () => {
  const issues = classifyIssues([], [duplicate('fp', [['a.ts', 1, 14], ['b.ts', 1, 14]])],
    changes(edit('b.ts', [range(1, 14)], [], null)), sources);
  assert.deepEqual(effects(issues), ['new']);
  assert.equal(issues[0]?.finding.path, 'b.ts');
  assert.deepEqual(issues[0]?.context, [{ path: 'a.ts', line: 1, endLine: 14 }]);
});

test('a duplicate gaining a copy is worsened, and losing one is improved', () => {
  const two = duplicate('fp', [['a.ts', 1, 14], ['b.ts', 1, 14]]);
  const three = duplicate('fp', [['a.ts', 1, 14], ['b.ts', 1, 14], ['c.ts', 1, 14]]);
  const gained = classifyIssues([two], [three], changes(edit('c.ts', [range(1, 14)], [], null)), sources);
  assert.deepEqual(gained.map(issue => [issue.effect, issue.before]), [['worsened', 2]]);
  const lost = classifyIssues([three], [two], changes({ path: null, previous: 'c.ts', added: [], removed: [range(1, 14)], whole: false, hunks: [] }), sources);
  assert.deepEqual(effects(lost), ['improved']);
  assert.equal(lost[0]?.fixed, false);
});

test('an issue on removed lines that is gone is improved and fixed', () => {
  const issues = classifyIssues([complexity('a.ts', 40, 77, 'parse', 22)], [], changes(edit('a.ts', [range(40, 60)], [range(40, 77)])), sources);
  assert.deepEqual(issues.map(issue => [issue.effect, issue.fixed, issue.finding.anchor]), [['improved', true, 'parse']]);
});

test('a deleted file has all its issues fixed', () => {
  const issues = classifyIssues([complexity('gone.ts', 1, 20, 'one', 20), complexity('gone.ts', 22, 40, 'two', 18)], [],
    changes({ path: null, previous: 'gone.ts', added: [], removed: [range(1, 40)], whole: false, hunks: [] }), sources);
  assert.deepEqual(issues.map(issue => [issue.effect, issue.fixed]), [['improved', true], ['improved', true]]);
});

test('security issues come first', () => {
  const secret: Finding = { tool: 'repometry', rule: 'private-key', category: 'secret', level: 'high',
    message: 'Private key', path: 'z.ts', line: 3 };
  const issues = classifyIssues([], [complexity('a.ts', 1, 20, 'run', 20), secret],
    changes(edit('a.ts', [range(1, 20)], []), edit('z.ts', [range(3)], [])), sources);
  assert.deepEqual(issues.map(issue => issue.finding.category), ['secret', 'structure']);
});

test('a finding past the end of its file counts for the whole file', () => {
  const stale: Finding = { tool: 'scanner', rule: 'stale', category: 'lint', level: 'low', message: 'Stale', path: 'a.ts', line: 900 };
  const short: SourceLines = { line: (_path, line) => (line <= 10 ? 'code' : undefined) };
  const issues = classifyIssues([], [stale], changes(edit('a.ts', [range(1, 2)], [])), { base: short, head: short });
  assert.deepEqual(effects(issues), ['new']);
});

test('whole-file changes put every issue of the file in scope', () => {
  const issues = classifyIssues([], [complexity('a.ts', 50, 60, 'run', 20)],
    changes({ path: 'a.ts', previous: 'a.ts', added: [], removed: [], whole: true, hunks: [] }), sources);
  assert.deepEqual(effects(issues), ['new']);
});

test('the debt effect adds new and worsened effort and removes fixed and improved effort', () => {
  const issues = classifyIssues(
    [complexity('a.ts', 1, 20, 'worsened', 17), complexity('a.ts', 30, 50, 'fixed', 18), complexity('a.ts', 60, 80, 'better', 22)],
    [complexity('a.ts', 1, 20, 'worsened', 19), complexity('a.ts', 60, 80, 'better', 18), complexity('a.ts', 90, 99, 'new', 17)],
    changes(edit('a.ts', [range(5), range(65), range(95)], [range(5), range(35), range(65)])), sources);
  assert.deepEqual(effects(issues), ['new', 'worsened', 'improved', 'improved']);
  assert.deepEqual(debtEffect(issues), { added: 20 + 20, removed: 30 + 40 });
});

const handler = (path: string, line: number, endLine: number, value: number): Finding => ({ ...complexity(path, line, endLine, '(anonymous)', value),
  message: `(anonymous) · Cognitive complexity ${value} (limit 15)` });
const firstLines = (lines: Readonly<Record<number, string>>): SourceLines => ({ line: (_path, line) => lines[line] ?? 'body' });

test('simplifying one of several unnamed handlers leaves the others alone', () => {
  // Handler /a shrinks from 14 lines at complexity 20 to 10 lines under the limit; /b moves up 4 lines, unchanged.
  const issues = classifyIssues([handler('app.ts', 1, 14, 20), handler('app.ts', 16, 44, 25)], [handler('app.ts', 12, 40, 25)],
    changes(edit('app.ts', [range(2, 9)], [range(2, 13)], 'app.ts', [{ base: { first: 2, count: 12 }, head: { first: 2, count: 8 } }])),
    { base: firstLines({ 1: "app.get('/a', req => {", 16: "app.get('/b', req => {" }), head: firstLines({ 1: "app.get('/a', req => {", 12: "app.get('/b', req => {" }) });
  assert.deepEqual(issues.map(issue => [issue.effect, issue.fixed, issue.finding.line]), [['improved', true, 1]]);
});

test('a new unnamed handler above another is new, and the other is left alone', () => {
  const issues = classifyIssues([handler('app.ts', 1, 29, 25)], [handler('app.ts', 1, 14, 18), handler('app.ts', 16, 44, 25)],
    changes(edit('app.ts', [range(1, 15)], [], 'app.ts', [{ base: { first: 0, count: 0 }, head: { first: 1, count: 15 } }])),
    { base: firstLines({ 1: "app.get('/b', req => {" }), head: firstLines({ 1: "app.get('/c', req => {", 16: "app.get('/b', req => {" }) });
  assert.deepEqual(issues.map(issue => [issue.effect, issue.finding.line]), [['new', 1]]);
});

test('renaming a function keeps its issue', () => {
  const issues = classifyIssues([complexity('a.ts', 1, 36, 'run', 31)], [complexity('a.ts', 1, 36, 'execute', 31)],
    changes(edit('a.ts', [range(1)], [range(1)], 'a.ts', [{ base: { first: 1, count: 1 }, head: { first: 1, count: 1 } }])),
    { base: firstLines({ 1: 'export function run(v) {' }), head: firstLines({ 1: 'export function execute(v) {' }) });
  assert.deepEqual(issues.map(issue => [issue.effect, issue.before, issue.finding.anchor]), [['touched', 31, 'execute']]);
});

test('a function rewritten in full is new, and the old one fixed', () => {
  const issues = classifyIssues([complexity('a.ts', 1, 20, 'run', 20)], [complexity('a.ts', 1, 20, 'execute', 22)],
    changes(edit('a.ts', [range(1, 20)], [range(1, 20)], 'a.ts', [{ base: { first: 1, count: 20 }, head: { first: 1, count: 20 } }])),
    { base: firstLines({ 1: 'function run() {' }), head: firstLines({ 1: 'function execute() {' }) });
  assert.deepEqual(issues.map(issue => [issue.effect, issue.fixed]), [['new', false], ['improved', true]]);
});

test('a named function rewritten with a new signature is still the same issue', () => {
  const issues = classifyIssues([complexity('a.ts', 30, 60, 'projectReview', 22)], [complexity('a.ts', 33, 51, 'projectReview', 16)],
    changes(edit('a.ts', [range(1, 80)], [range(1, 90)], 'a.ts', [{ base: { first: 1, count: 90 }, head: { first: 1, count: 80 } }])),
    { base: firstLines({ 30: 'export function projectReview(request) {' }), head: firstLines({ 33: 'export function projectReview(options, inputs) {' }) });
  assert.deepEqual(issues.map(issue => [issue.effect, issue.before, issue.fixed]), [['improved', 22, false]]);
});
