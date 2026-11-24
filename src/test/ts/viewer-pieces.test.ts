import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickerStatus } from '../../main/ts/report/html/app/viewer-commit-picker.js';
import { chosenLabel } from '../../main/ts/report/html/app/viewer-controls.js';
import { ignoreRecord, literalPath } from '../../main/ts/report/html/app/viewer-issue-group.js';
import { toggleLanguage } from '../../main/ts/report/html/app/viewer-language-bar.js';
import { coverageGrade, gradeScope } from '../../main/ts/report/html/app/viewer-metrics.js';
import { tableSummary } from '../../main/ts/report/html/app/viewer-profile-table.js';
import { href, readRoute } from '../../main/ts/report/html/app/viewer-route.js';
import { excerptRange } from '../../main/ts/report/html/app/viewer-source-view.js';
import { spokenList } from '../../main/ts/report/html/app/viewer-table-cells.js';
import { hotspotScore, scorePeak } from '../../main/ts/report/html/app/viewer-file-figures.js';
import { languageShares } from '../../main/ts/report/html/app/viewer-languages.js';
import { partialNote } from '../../main/ts/report/html/app/viewer-totals.js';
import type { Metrics } from '../../main/ts/report/html/app/viewer-inspection.js';

const sha = 'a'.repeat(40);
const older = 'b'.repeat(40);

test('a route travels through the URL and comes back the same', () => {
  const route = { page: 'issues', sha: older, file: 'src/a b.ts', category: 'structure,duplication', level: 'high', line: 12 } as const;
  const link = href(route);
  assert.equal(link, `#issues?sha=${older}&file=src%2Fa+b.ts&line=12&category=structure,duplication&level=high`);
  const back = readRoute(link, new Set([sha, older]), sha);
  assert.deepEqual({ page: back.page, sha: back.sha, file: back.file, category: back.category, level: back.level, line: back.line },
    { ...route });
});

test('a route falls back to the newest commit and the Overview, and old component links open Metrics', () => {
  const commits = new Set([sha, older]);
  assert.deepEqual(readRoute(`#${older}`, commits, sha), { page: 'overview', sha: older });
  const unknown = readRoute('#nowhere?sha=c&line=-3&view=nonsense', commits, sha);
  assert.deepEqual([unknown.page, unknown.sha, unknown.line, unknown.view], ['overview', sha, undefined, undefined]);
  assert.deepEqual(readRoute(`#components?sha=${older}`, commits, sha), { page: 'metrics', sha: older, group: 'components' });
});

test('a language chip toggles by name in any case; a category chip toggles its own clause', () => {
  assert.deepEqual(toggleLanguage([], 'TypeScript'), [{ kind: 'lang', value: 'TypeScript' }]);
  assert.deepEqual(toggleLanguage([{ kind: 'lang', value: 'typescript' }, { kind: 'path', value: 'src' }], 'TypeScript'),
    [{ kind: 'path', value: 'src' }]);
  assert.deepEqual(toggleLanguage([], 'Lockfiles'), [{ kind: 'lockfile', value: 'yes' }]);
  assert.deepEqual(toggleLanguage([{ kind: 'analysed', value: 'no' }], 'Ignored'), []);
});

test('an ignore entry names the file only where its path can be matched literally', () => {
  assert.deepEqual(ignoreRecord({ tool: 'repometry', rule: 'function-complexity', path: 'src/a.ts' }),
    { tool: 'repometry', rule: 'function-complexity', path: 'src/a.ts' });
  assert.deepEqual(ignoreRecord({ tool: 'eslint', rule: 'no-eval', path: 'src/*.ts' }), { tool: 'eslint', rule: 'no-eval' });
  assert.equal(ignoreRecord({ tool: ' ', rule: 'x' }), undefined);
  assert.equal(ignoreRecord({ tool: 'a', rule: 'line\nbreak' }), undefined);
  for (const path of ['../a.ts', 'a//b.ts', '!a.ts', 'C:/a.ts', './a.ts', 'a\\b.ts']) assert.equal(literalPath(path), false, path);
  assert.equal(literalPath('.github/workflows/ci.yaml'), true);
});

test('the counts under lists read the same way everywhere', () => {
  assert.equal(chosenLabel([], 'All tools', 'tools'), 'All tools');
  assert.equal(chosenLabel(['eslint', 'repometry'], 'All tools', 'tools'), 'eslint, repometry');
  assert.equal(chosenLabel(['a', 'b', 'c'], 'All tools', 'tools'), '3 tools');
  assert.equal(tableSummary(['rule', 'rules'], 0, 9, 0, 0), 'No rules match.');
  assert.equal(tableSummary(['rule', 'rules'], 1, 1, 0, 1), '1 rule');
  assert.equal(tableSummary(['rule', 'rules'], 4, 9, 0, 4), '4 of 9 rules');
  assert.equal(tableSummary(['rule', 'rules'], 120, 120, 50, 50), '51–100 of 120 rules');
  assert.equal(pickerStatus(0, 0, 'fix', undefined), 'No commits match “fix”');
  assert.equal(pickerStatus(300, 50, '', 'main'), '50 of 300 commits · type to narrow');
  assert.equal(pickerStatus(12, 12, '', 'main'), '12 commits on main');
  assert.equal(pickerStatus(1, 1, 'fix', 'main'), '1 commit');
  assert.equal(spokenList(['1 lockfile', '2 files', '3 folders']), '1 lockfile, 2 files and 3 folders');
  assert.equal(spokenList(['2 files']), '2 files');
});

test('line coverage is graded as the coverage badge grades it', () => {
  assert.deepEqual([.95, .9, .85, .73, .691, .6, .2].map(coverageGrade), ['A', 'A', 'B', 'C', 'D', 'D', 'F']);
});

test('an excerpt shows a line of context and the head of the range, and counts the rest', () => {
  assert.deepEqual(excerptRange(100, { line: 10, endLine: 40 }), { from: 9, to: 14, end: 40 });
  assert.deepEqual(excerptRange(100, { line: 1 }), { from: 1, to: 1, end: 1 });
  assert.deepEqual(excerptRange(12, { line: 10, endLine: 40 }), { from: 9, to: 12, end: 12 });
});

const measured = (path: string, quality: Record<string, unknown> | undefined, complexity: unknown = null) =>
  ({ path, lines: 10, functions: 1, complexity, lineCoverage: null, diagnosticCount: 0, ...quality ? { quality } : {} }) as unknown as Metrics;

test('an unknown score stays unknown; a file measured without functions scores zero', () => {
  assert.equal(hotspotScore(measured('a.go', { codeLines: 9 }), 'cognitive'), null);
  assert.equal(hotspotScore(measured('a.ts', { cognitiveComplexity: 0 }), 'cognitive'), 0);
  assert.equal(hotspotScore(measured('b.py', {}, { sum: 0, maximum: null, measuredFunctions: 0 }), 'complexity'), 0);
  assert.equal(hotspotScore(measured('c.py', {}), 'complexity'), null);
  assert.equal(scorePeak([null, 3, null, 7]), 7);
  assert.equal(scorePeak([null, 0]), 1);
});

test('a total says it is partial only where some files with code measures lack the counter', () => {
  const cognitive = (entry: Metrics) => entry.quality?.cognitiveComplexity !== undefined;
  const ts = measured('a.ts', { codeLines: 9, cognitiveComplexity: 4 });
  const go = measured('b.go', { codeLines: 9 });
  // A workflow only a scanner read has no code measures and is not expected to carry any.
  const workflow = measured('.github/ci.yaml', undefined);
  assert.equal(partialNote([ts, go, workflow], cognitive), 'Measured in 1 of 2 files');
  assert.equal(partialNote([ts, workflow], cognitive), undefined);
  assert.equal(partialNote([go], cognitive), undefined);
});

test('the language bar weighs code lines only where every file has them', () => {
  const file = (path: string, codeLines?: number) => ({ path, lines: 20, ...codeLines === undefined ? {} : { quality: { codeLines } } });
  assert.equal(languageShares([file('a.ts', 10), file('b.ts', 12)]).measure, 'code-lines');
  assert.equal(languageShares([file('a.ts', 10), file('b.go')]).measure, 'lines');
});

test('a grade over only some files says how many; a grade over all of them says nothing more', () => {
  const quality = (gradeCoverage?: { measuredFiles: number; totalFiles: number }) =>
    ({ maintainability: { smells: 0, effortMinutes: 0, debtRatio: .02, grade: 'A', ...gradeCoverage ? { gradeCoverage } : {} } }) as never;
  assert.equal(gradeScope(quality({ measuredFiles: 1, totalFiles: 2 })), 'Graded on 1 of 2 files');
  assert.equal(gradeScope(quality({ measuredFiles: 2, totalFiles: 2 })), undefined);
  assert.equal(gradeScope(quality()), undefined);
  assert.equal(gradeScope(undefined), undefined);
});
