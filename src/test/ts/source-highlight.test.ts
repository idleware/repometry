import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageIdOf, useLanguages } from '../../main/ts/report/html/app/viewer-languages.js';
import { tokenizer } from '../../main/ts/report/html/app/viewer-tokenizer.js';

const kinds = (runs: readonly (readonly [string, string])[], kind: string) => runs.filter(([run]) => run === kind).map(([, value]) => value);

test('a regular expression with a slash in its class and quotes inside stays one run', () => {
  const tokenize = tokenizer('typescript');
  const runs = tokenize(String.raw`export const importRe =         /((\.{3}|\s|[!%&(*+,/:;<=>?[^{|}~-]|^)import\s?\(?\s?|\sfrom)\s?$/`);
  assert.deepEqual(kinds(runs, 's'), [String.raw`/((\.{3}|\s|[!%&(*+,/:;<=>?[^{|}~-]|^)import\s?\(?\s?|\sfrom)\s?$/`]);
  // The next line starts clean.
  assert.deepEqual(kinds(tokenize('const isDep = (v: string) => !!v'), 'k'), ['const']);
});

test('an escaped backtick does not close a template literal', () => {
  const tokenize = tokenizer('typescript');
  const runs = tokenize("const isQ = (v: string) => `\"'\\``.includes(v)");
  assert.deepEqual(kinds(runs, 's'), ['`', "\"'\\``"]);
  // Nothing is left open: the function after it is plain code.
  const after = tokenize('const extract = (readable: TPseudoReadable, _opts?: TOpts): TCodeRef[] => {');
  assert.deepEqual(kinds(after, 's'), []);
  assert.deepEqual(kinds(after, 'k'), ['const']);
});

test('a slash after a value divides, and comments and strings keep their colour', () => {
  const tokenize = tokenizer('typescript');
  assert.deepEqual(kinds(tokenize('const half = total / 2 / (count) / list[0]'), 's'), []);
  const runs = tokenize("const re = /a\\/b/g // note 'quoted'");
  assert.deepEqual(kinds(runs, 's'), ['/a\\/b/g']);
  assert.deepEqual(kinds(runs, 'c'), ["// note 'quoted'"]);
  const block = tokenizer('typescript');
  assert.deepEqual(kinds(block('x /* open'), 'c'), ['/*', ' open']);
  assert.deepEqual(kinds(block('still */ y'), 'c'), ['still */']);
});

test('other languages come back as plain text', () => {
  assert.deepEqual(tokenizer('markdown')('`code` and "quotes"'), [['', '`code` and "quotes"']]);
});

test('a file is read by the language the inspection gives it; Go and Python stay plain, never in JavaScript colours', () => {
  useLanguages({ languages: [{ id: 'go', label: 'Go', analysed: true }, { id: 'typescript', label: 'TypeScript', analysed: true }],
    files: [{ path: 'cmd/main.go', language: 0 }, { path: 'src/a.ts', language: 1 }, { path: 'README', language: 7 }] } as never);
  assert.equal(languageIdOf('cmd/main.go'), 'go');
  assert.equal(languageIdOf('src/a.ts'), 'typescript');
  assert.equal(languageIdOf('README'), undefined);
  assert.equal(languageIdOf('nowhere.ts'), undefined);
  assert.deepEqual(tokenizer('go')('x := "a" // b'), [['', 'x := "a" // b']]);
  assert.deepEqual(tokenizer('python')('def f(): # b'), [['', 'def f(): # b']]);
  assert.deepEqual(tokenizer(undefined)('const a = 1'), [['', 'const a = 1']]);
});
