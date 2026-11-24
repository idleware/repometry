import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseLabel, formatQuery, matches, parseQuery } from '../../main/ts/report/html/app/viewer-filter.js';
import { isLockfile, languageColor, languageOf, languageShares, useLanguages } from '../../main/ts/report/html/app/viewer-languages.js';
import { suggest } from '../../main/ts/report/html/app/viewer-suggest.js';
import { size } from '../../main/ts/report/html/app/viewer-metrics.js';
import type { FileFacts } from '../../main/ts/report/html/app/viewer-filter.js';

// The inspection names its languages, and each file points to one by index, as an export carries them.
useLanguages([
  { id: 'typescript', label: 'TypeScript', color: '#3178c6', analysed: true },
  { id: 'javascript', label: 'JavaScript', color: '#f1e05a', analysed: true },
  { id: 'markdown', label: 'Markdown', color: '#768390', analysed: false },
  { id: 'other', label: 'Other', analysed: false },
]);
/** The index the inspection's language list gives a file of this extension; anything else is Other. */
function indexOf(path: string): number {
  const found = ['.ts', '.js', '.md'].findIndex(extension => path.endsWith(extension));
  return found < 0 ? 3 : found;
}

const file = (path: string, maximum: number | null, coverage: [number, number] | null = null) => ({
  path, language: indexOf(path), lines: 10, functions: 1, complexity: maximum === null ? null : { sum: maximum, maximum, measuredFunctions: 1 },
  lineCoverage: coverage ? { covered: coverage[0], total: coverage[1] } : null, diagnosticCount: 0,
});
const facts: FileFacts = { components: new Map([['src/core/a.ts', ['Core API']]]), findings: new Map([['src/util/b.js', 2]]) };

test('the query round-trips through text, quoting names with spaces', () => {
  const clauses = parseQuery('lang:TypeScript component:"Core API" complexity>10 coverage<80% has:findings src/');
  assert.deepEqual(clauses.map(clause => clause.kind), ['lang', 'component', 'measure', 'measure', 'has', 'path']);
  assert.equal(formatQuery(clauses), 'lang:TypeScript component:"Core API" complexity>10 coverage<80% has:findings src/');
  assert.deepEqual(parseQuery('coverage<80%')[0], { kind: 'measure', measure: 'coverage', operator: '<', value: .8 });
  assert.deepEqual(parseQuery('remediation>2h')[0], { kind: 'measure', measure: 'remediation', operator: '>', value: 120 });
  assert.equal(parseQuery('unknown>3')[0], undefined);
});

test('chips of one kind widen, of different kinds narrow, and conditions must all hold', () => {
  const a = file('src/core/a.ts', 12, [7, 10]);
  const b = file('src/util/b.js', 3);
  const c = file('docs/c.md', null);
  assert.equal(languageOf(a), 'TypeScript');
  assert.equal(languageOf(c), 'Markdown');
  const pick = (query: string) => [a, b, c].filter(entry => matches(entry, parseQuery(query), facts)).map(entry => entry.path);
  assert.deepEqual(pick('lang:TypeScript lang:JavaScript'), ['src/core/a.ts', 'src/util/b.js']);
  assert.deepEqual(pick('lang:JavaScript has:findings'), ['src/util/b.js']);
  assert.deepEqual(pick('component:"core api"'), ['src/core/a.ts']);
  assert.deepEqual(pick('complexity>10 coverage<80%'), ['src/core/a.ts']);
  assert.deepEqual(pick('complexity>2 util'), ['src/util/b.js']);
  // A file without the measurement never passes a condition on it.
  assert.deepEqual(pick('coverage<100%'), ['src/core/a.ts']);
});

test("a file's language and its colour are the inspection's; a file it names none for is Other, in grey", () => {
  assert.equal(languageOf({ language: 1 }), 'JavaScript');
  assert.equal(languageOf({ language: 3 }), 'Other');
  assert.equal(languageOf({ language: 9 }), 'Other');
  assert.equal(languageOf({}), 'Other');
  assert.equal(languageColor('TypeScript'), '#3178c6');
  assert.equal(languageColor('Markdown'), '#768390');
  assert.equal(languageColor('Other'), 'var(--neutral-2)');
});

test('files no plugin read are "ignored" on screen, and the query takes either word', () => {
  const read = file('src/a.ts', 3);
  const ignored = { ...file('docs/readme.md', null), analysed: false };
  const pick = (query: string) => [read, ignored].filter(entry => matches(entry, parseQuery(query), facts)).map(entry => entry.path);
  assert.deepEqual(pick('ignored:yes'), ['docs/readme.md']);
  assert.deepEqual(pick('ignored:no'), ['src/a.ts']);
  assert.deepEqual(pick('analysed:no'), ['docs/readme.md']);
  // The query text and the URL use the chip's word; the old spelling still parses.
  assert.equal(formatQuery(parseQuery('ignored:yes')), 'ignored:yes');
  assert.equal(formatQuery(parseQuery('analysed:no')), 'ignored:yes');
  assert.equal(formatQuery(parseQuery('analysed:yes')), 'ignored:no');
  assert.deepEqual(clauseLabel(parseQuery('ignored:yes')[0]!), { key: 'Ignored', value: 'Yes' });
  for (const typed of ['ign', 'ignored f', 'not ana']) {
    assert.deepEqual(suggest(typed, [read, ignored], facts, []).filter(item => item.group === 'Conditions').map(item => item.label), ['Ignored files'], typed);
  }
});

test('lockfiles are known by their exact file name at any depth, and nothing like them passes', () => {
  for (const path of ['package-lock.json', 'apps/web/yarn.lock', 'a/b/c/pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'src/gradle.lockfile']) {
    assert.equal(isLockfile(path), true, path);
  }
  for (const path of ['package-lock.json.bak', 'old-package-lock.json', 'Package-Lock.json', 'cargo.lock', 'yarn.lock/readme.md',
    'package-lock.jsonc', 'go.sum.txt', 'src/lock.json']) {
    assert.equal(isLockfile(path), false, path);
  }
});

test('the language bar weighs lockfiles apart from the languages and from the ignored files', () => {
  const entry = (path: string, lines: number, codeLines: number | undefined, analysed = true) =>
    ({ path, language: indexOf(path), lines, analysed, ...codeLines === undefined ? {} : { quality: { codeLines } } });
  const files = [
    entry('src/a.ts', 300, 200), entry('src/b.js', 50, 40), entry('package-lock.json', 9575, undefined, false),
    entry('README.md', 160, undefined, false), entry('LICENSE', 21, undefined, false),
  ];
  assert.deepEqual(languageShares(files), {
    measure: 'lines',
    shares: [['TypeScript', 300], ['JavaScript', 50], ['Lockfiles', 9575], ['Ignored', 181]],
  });
  // Every file analysed and no lockfile: the bar weighs code lines and has no category of its own.
  assert.deepEqual(languageShares(files.slice(0, 2)), { measure: 'code-lines', shares: [['TypeScript', 200], ['JavaScript', 40]] });
  // A lockfile alone among analysed code still turns the bar to physical lines: it has no code lines.
  assert.equal(languageShares([...files.slice(0, 2), files[2]!]).measure, 'lines');
});

test('lockfile:yes selects lockfiles, and ignored:yes leaves them out', () => {
  const code = file('src/a.ts', 3);
  const lock = { ...file('package-lock.json', null), analysed: false };
  const readme = { ...file('README.md', null), analysed: false };
  const pick = (query: string) => [code, lock, readme].filter(entry => matches(entry, parseQuery(query), facts)).map(entry => entry.path);
  assert.deepEqual(pick('lockfile:yes'), ['package-lock.json']);
  assert.deepEqual(pick('lockfile:no'), ['src/a.ts', 'README.md']);
  assert.deepEqual(pick('ignored:yes'), ['README.md']);
  assert.deepEqual(pick('ignored:no'), ['src/a.ts', 'package-lock.json']);
  assert.equal(formatQuery(parseQuery('lockfiles:yes')), 'lockfile:yes');
  assert.deepEqual(clauseLabel(parseQuery('lockfile:yes')[0]!), { key: 'Lockfile', value: 'Yes' });
  const offered = (typed: string) => suggest(typed, [code, lock, readme], facts, []).filter(item => item.group === 'Conditions').map(item => `${item.label} ${item.detail}`);
  assert.deepEqual(offered('lock'), ['Lockfiles 1 file']);
  assert.deepEqual(offered('ignored'), ['Ignored files 1 file']);
});

test('with every file sized, the bar weighs bytes for code, lockfiles and ignored files alike', () => {
  const entry = (path: string, lines: number, bytes: number | undefined, analysed = true) =>
    ({ path, language: indexOf(path), lines, analysed, quality: { codeLines: lines - 10 }, ...bytes === undefined ? {} : { bytes } });
  const files = [entry('src/zurk.ts', 155, 4902), entry('package-lock.json', 9575, 348651, false), entry('README.md', 160, 6100, false)];
  assert.deepEqual(languageShares(files), { measure: 'bytes', shares: [['TypeScript', 4902], ['Lockfiles', 348651], ['Ignored', 6100]] });
  // One file from an inspection without sizes sends the whole bar back to lines: no mixed measures.
  assert.equal(languageShares([...files, entry('src/old.ts', 40, undefined)]).measure, 'lines');
  assert.equal(languageShares([]).measure, 'code-lines');
});

test('sizes read in binary units, one decimal below ten', () => {
  assert.equal(size(undefined), '—');
  assert.equal(size(0), '0 B');
  assert.equal(size(512), '512 B');
  assert.equal(size(4902), '4.8 KB');
  assert.equal(size(348651), '340 KB');
  assert.equal(size(1258291), '1.2 MB');
  // Rounding never shows 1,024 of a unit.
  assert.equal(size(1048575), '1 MB');
});
