import assert from 'node:assert/strict';
import { test } from 'node:test';
import { go } from '@repometry/language-go';
import { python } from '@repometry/language-python';
import { jsSyntax } from '../../main/ts/plugins/language-js/syntax.js';
import { languageIdOf, syntaxOf, useLanguages } from '../../main/ts/report/html/app/viewer-languages.js';
import { tokenizer } from '../../main/ts/report/html/app/viewer-tokenizer.js';
import type { LanguageSyntax } from '../../main/ts/report/json/wire/file-metrics-model.js';

const [goSyntax, pythonSyntax] = [go.language.syntax!, python.language.syntax!];

const kinds = (runs: readonly (readonly [string, string])[], kind: string) => runs.filter(([run]) => run === kind).map(([, value]) => value);

test('a regular expression with a slash in its class and quotes inside stays one run', () => {
  const tokenize = tokenizer(jsSyntax);
  const runs = tokenize(String.raw`export const importRe =         /((\.{3}|\s|[!%&(*+,/:;<=>?[^{|}~-]|^)import\s?\(?\s?|\sfrom)\s?$/`);
  assert.deepEqual(kinds(runs, 's'), [String.raw`/((\.{3}|\s|[!%&(*+,/:;<=>?[^{|}~-]|^)import\s?\(?\s?|\sfrom)\s?$/`]);
  // The next line starts clean.
  assert.deepEqual(kinds(tokenize('const isDep = (v: string) => !!v'), 'k'), ['const']);
});

test('an escaped backtick does not close a template literal', () => {
  const tokenize = tokenizer(jsSyntax);
  const runs = tokenize("const isQ = (v: string) => `\"'\\``.includes(v)");
  assert.deepEqual(kinds(runs, 's'), ['`', "\"'\\``"]);
  // Nothing is left open: the function after it is plain code.
  const after = tokenize('const extract = (readable: TPseudoReadable, _opts?: TOpts): TCodeRef[] => {');
  assert.deepEqual(kinds(after, 's'), []);
  assert.deepEqual(kinds(after, 'k'), ['const']);
});

test('a slash after a value divides, and comments and strings keep their colour', () => {
  const tokenize = tokenizer(jsSyntax);
  assert.deepEqual(kinds(tokenize('const half = total / 2 / (count) / list[0]'), 's'), []);
  const runs = tokenize("const re = /a\\/b/g // note 'quoted'");
  assert.deepEqual(kinds(runs, 's'), ['/a\\/b/g']);
  assert.deepEqual(kinds(runs, 'c'), ["// note 'quoted'"]);
  const block = tokenizer(jsSyntax);
  assert.deepEqual(kinds(block('x /* open'), 'c'), ['/*', ' open']);
  assert.deepEqual(kinds(block('still */ y'), 'c'), ['still */']);
});

test('a language with no syntax comes back as plain text', () => {
  assert.deepEqual(tokenizer(undefined)('`code` and "quotes"'), [['', '`code` and "quotes"']]);
});

test('Go: strings, runes, raw strings across lines, block comments and keywords', () => {
  const tokenize = tokenizer(goSyntax);
  const runs = tokenize(String.raw`x := "a\"b" // c`);
  assert.deepEqual(kinds(runs, 's'), [String.raw`"a\"b"`]);
  assert.deepEqual(kinds(runs, 'c'), ['// c']);
  assert.deepEqual(kinds(tokenize("r := '\\''"), 's'), ["'\\''"]);
  assert.deepEqual(kinds(tokenize('s := `a\\'), 's'), ['`', 'a\\']);
  // The backslash before the line's end does not escape: the backtick on the next line closes the string.
  assert.deepEqual(kinds(tokenize('b` + y'), 's'), ['b`']);
  assert.deepEqual(kinds(tokenize('/* open'), 'c'), ['/*', ' open']);
  assert.deepEqual(kinds(tokenize('shut */ x'), 'c'), ['shut */']);
  assert.deepEqual(kinds(tokenize('func f() *T { return nil }'), 'k'), ['func', 'return', 'nil']);
});

test('Python: comments, prefixed and triple-quoted strings, and keywords', () => {
  const tokenize = tokenizer(pythonSyntax);
  assert.deepEqual(kinds(tokenize('x = 1  # note'), 'c'), ['# note']);
  const hash = tokenize('s = "#"');
  assert.deepEqual(kinds(hash, 's'), ['"#"']);
  assert.deepEqual(kinds(hash, 'c'), []);
  assert.deepEqual(kinds(tokenize('doc = """one'), 's'), ['"""', 'one']);
  assert.deepEqual(kinds(tokenize('two " still"""'), 's'), ['two " still"""']);
  assert.deepEqual(kinds(tokenize(`a = rb'x' + F"{a}"`), 's'), ["rb'x'", 'F"{a}"']);
  assert.deepEqual(kinds(tokenize('def f(match): return None'), 'k'), ['def', 'return', 'None']);
});

test('a language that exists only here gets colours with no viewer change', () => {
  const fixture: LanguageSyntax = { lineComments: [';'], strings: [{ quote: '~' }], keywords: ['zap'] };
  const expected = [['k', 'zap'], ['', ' '], ['s', '~a~'], ['', ' '], ['c', '; note']];
  assert.deepEqual(tokenizer(fixture)('zap ~a~ ; note'), expected);
  useLanguages({ languages: [{ id: 'fixture', analysed: true, syntax: fixture }, { id: 'plain', analysed: true }],
    files: [{ path: 'a.fixture', language: 0 }, { path: 'b.plain', language: 1 }] } as never);
  assert.equal(syntaxOf('a.fixture'), fixture);
  assert.deepEqual(tokenizer(syntaxOf('a.fixture'))('zap ~a~ ; note'), expected);
  assert.deepEqual(tokenizer(syntaxOf('b.plain'))('zap ~a~'), [['', 'zap ~a~']]);
});

test('a file is read by the language the inspection gives it', () => {
  useLanguages({ languages: [{ id: 'go', label: 'Go', analysed: true, syntax: goSyntax }, { id: 'typescript', label: 'TypeScript', analysed: true }],
    files: [{ path: 'cmd/main.go', language: 0 }, { path: 'src/a.ts', language: 1 }, { path: 'README', language: 7 }] } as never);
  assert.equal(languageIdOf('cmd/main.go'), 'go');
  assert.equal(languageIdOf('src/a.ts'), 'typescript');
  assert.equal(languageIdOf('README'), undefined);
  assert.equal(languageIdOf('nowhere.ts'), undefined);
  assert.equal(syntaxOf('cmd/main.go'), goSyntax);
  assert.equal(syntaxOf('README'), undefined);
  assert.deepEqual(tokenizer(undefined)('const a = 1'), [['', 'const a = 1']]);
});
