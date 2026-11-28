import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralCheck } from '@repometry/core';
import { isLanguageSyntax } from '@repometry/core/internal/model/language.js';
import manifest, { java } from '@repometry/language-java';

const parser = manifest.create().operations[0]!;

async function parse(source: string): Promise<CodeStructure> {
  const file = { path: 'Sample.java', bytes: Buffer.from(source) };
  const result = await parser.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return file as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

function observations(result: CodeStructure, check: StructuralCheck) {
  return result.observations!.filter(row => row.check === check)
    .map(({ anchor, line, endLine, value }) => [anchor, line, endLine, value]);
}

test('Java ships its pinned grammar and lexical data in a language manifest', async () => {
  assert.equal(manifest.id, 'language-java');
  assert.equal(manifest.category, 'language');
  assert.deepEqual(manifest.tools, { 'tree-sitter-java': '0.23.5' });
  const [language] = manifest.languages!;
  assert.equal(language?.id, 'java');
  assert.deepEqual(language?.include, ['**/*.java']);
  assert.deepEqual(language?.measures, [
    'functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'commentLines', 'codeLines', 'checks', 'duplication', 'classes',
  ]);
  const syntax = language?.syntax;
  assert.ok(isLanguageSyntax(syntax));
  assert.deepEqual(syntax.lineComments, ['//']);
  assert.deepEqual(syntax.blockComments, [['/*', '*/']]);
  assert.deepEqual(syntax.strings, [{ quote: '"""', multiline: true }, { quote: '"' }, { quote: "'" }]);
  assert.equal(new Set(syntax.keywords).size, 54);
  for (const word of ['class', 'synchronized', '_', 'true', 'false', 'null']) assert.ok(syntax.keywords?.includes(word));
  for (const word of ['module', 'record', 'sealed', 'var', 'when', 'yield']) assert.ok(!syntax.keywords?.includes(word));

  const provenance = JSON.parse(await readFile(new URL('grammar.json', java.asset), 'utf8'));
  assert.equal(provenance.package, 'tree-sitter-java');
  assert.equal(provenance.version, '0.23.5');
  assert.equal(provenance.license, 'MIT');
  assert.match(provenance.integrity, /^sha512-/);
  assert.equal(hash('sha256', await readFile(java.asset)), provenance.sha256);
  assert.match(await readFile(new URL('tree-sitter.LICENSE', java.asset), 'utf8'), /Permission is hereby granted/);
});

test('Java measures declared types, methods, constructors and each form of lambda', async () => {
  const result = await parse([
    '// Unit declarations.',
    'class Meter {',
    '  Meter() { this(1); }',
    '  Meter(int seed) {}',
    '  class Inner { @Deprecated int size() { return 1; } }',
    '  void samples(Meter this, int base, String... labels) {',
    '    java.util.function.IntUnaryOperator bare = n -> n + base;',
    '    java.util.function.IntUnaryOperator grouped = (n) -> n;',
    '    java.util.function.IntBinaryOperator typed = (int x, int y) -> { if (x > 0) return x; return y; };',
    '    Runnable none = () -> {};',
    '    String marker = "😀"; Runnable positioned = () -> {};',
    '    class Local { int size() { return 2; } }',
    '  }',
    '}',
    'interface Limit {',
    '  default int max() { return 4; }',
    '}',
    'enum Level { HIGH; int weight() { return 1; } }',
    'record Point(int x, int y) {',
    '  Point { if (x < 0) throw new IllegalArgumentException(); }',
    '}',
    '@interface Tag { String value() default "t"; }',
  ].join('\n'));

  assert.equal(result.lines, 22);
  assert.equal(result.classes, 7);
  assert.equal(result.functions, 13);
  const functions = [
    ['Meter.Meter', 3, 3, 1, 0],
    ['Meter.Meter', 4, 3, 1, 0],
    ['Meter.Inner.size', 5, 17, 1, 0],
    ['Meter.samples', 6, 3, 1, 0],
    [undefined, 7, 48, 1, 0],
    [undefined, 8, 51, 1, 0],
    [undefined, 9, 50, 2, 1],
    [undefined, 10, 21, 1, 0],
    [undefined, 11, 48, 1, 0], // The supplementary character takes one codepoint column.
    ['Meter.samples.Local.size', 12, 19, 1, 0],
    ['Limit.max', 16, 3, 1, 0],
    ['Level.weight', 18, 20, 1, 0],
    ['Point.Point', 20, 3, 2, 1],
  ];
  assert.deepEqual(result.cyclomaticFunctions?.map(({ name, line, column, value }) => [name, line, column, value]),
    functions.map(([name, line, column, cyclomatic]) => [name, line, column, cyclomatic]));
  assert.deepEqual(result.cognitiveFunctions?.map(({ name, line, column, value }) => [name, line, column, value]),
    functions.map(([name, line, column, , cognitive]) => [name, line, column, cognitive]));
  assert.equal(result.cognitiveComplexity, 2);
  assert.ok(result.cyclomaticFunctions?.slice(4, 9).every(row => !Object.hasOwn(row, 'name')));

  const lambda = 'Meter.samples.(anonymous)';
  const scopes = [
    ['Meter.Meter', 3, 3, 0, 0],
    ['Meter.Meter', 4, 4, 1, 0],
    ['Meter.Inner.size', 5, 5, 0, 1],
    [lambda, 7, 7, 1, 0],
    [lambda, 8, 8, 1, 0],
    [lambda, 9, 9, 2, 2],
    [lambda, 10, 10, 0, 0],
    [lambda, 11, 11, 0, 0],
    ['Meter.samples.Local.size', 12, 12, 0, 1],
    ['Meter.samples', 6, 13, 2, 0],
    ['Limit.max', 16, 16, 0, 1],
    ['Level.weight', 18, 18, 0, 1],
    ['Point.Point', 20, 20, 0, 0],
  ];
  assert.deepEqual(observations(result, 'function-parameters'),
    scopes.map(([anchor, line, endLine, parameters]) => [anchor, line, endLine, parameters]));
  assert.deepEqual(observations(result, 'return-statements'),
    scopes.map(([anchor, line, endLine, , returns]) => [anchor, line, endLine, returns]));
  assert.deepEqual(observations(result, 'nested-control-flow'), [[lambda, 9, 9, 1], ['Point.Point', 20, 20, 1]]);
});

test('Java measures implemented methods and skips declarations without a body', async () => {
  const result = await parse([
    'abstract class Meter {',
    '  abstract int read(int offset);',
    '  native void reset(int mode);',
    '  int read() { return 1; }',
    '}',
    'interface Limit {',
    '  int min();',
    '  default int max() { return 4; }',
    '}',
  ].join('\n'));

  assert.equal(result.classes, 2);
  assert.equal(result.functions, 2);
  assert.deepEqual(result.cyclomaticFunctions, [
    { name: 'Meter.read', line: 4, column: 3, value: 1 },
    { name: 'Limit.max', line: 8, column: 3, value: 1 },
  ]);
  assert.deepEqual(observations(result, 'function-parameters'), [['Meter.read', 4, 4, 0], ['Limit.max', 8, 8, 0]]);
  assert.deepEqual(observations(result, 'return-statements'), [['Meter.read', 4, 4, 1], ['Limit.max', 8, 8, 1]]);
});

test('Java counts a bare lambda parameter', async () => {
  const result = await parse('class Bare { java.util.function.IntUnaryOperator fn = value -> value; }');
  assert.equal(result.functions, 1);
  assert.deepEqual(observations(result, 'function-parameters'), [['Bare.(anonymous)', 1, 1, 1]]);
});

test('Java measures nested decisions, the two switch forms, logical chains and labelled jumps', async () => {
  const result = await parse([
    'package sample;',
    '',
    '/** Computes a score.',
    ' * Uses both switch forms.',
    ' */',
    'class Score {',
    '  int evaluate(int[] values, boolean use, boolean strict, boolean fallback) {',
    '    int result = 0; // This is a code line.',
    '    outer: for (int i = 0; i < values.length; i++) {',
    '      for (int value : values) {',
    '        if (use && (strict || fallback)) {',
    '          if (value < 0 && i > 0 && use) continue outer;',
    '        } else if (value == 0) {',
    '          break outer;',
    '        } else {',
    '          continue;',
    '        }',
    '      }',
    '    }',
    '    try {',
    '      while (result < 5) result++;',
    '      do { result--; } while (result > 3);',
    '    } catch (RuntimeException error) {',
    '      result = strict ? 0 : 1;',
    '    }',
    '    switch (result) {',
    '      case 1:',
    '      case 2: result *= 3; break;',
    '      default: result = 1;',
    '    }',
    '    return switch (result) {',
    '      case 0, 1 -> 2;',
    '      case 2 -> { yield 3; }',
    '      default -> 4;',
    '    };',
    '  }',
    '}',
    '',
  ].join('\n'));

  const name = 'Score.evaluate';
  const location = { name, line: 7, column: 3 };
  assert.equal(result.lines, 37);
  assert.equal(result.commentLines, 3);
  assert.deepEqual(result.codeLines, [1, ...Array.from({ length: 32 }, (_, index) => index + 6)]);
  // Base 1, 2 for-loops, 3 ifs, 4 operators, while, do, catch, ternary, 4 non-default switch labels.
  assert.deepEqual(result.cyclomaticFunctions, [{ ...location, value: 18 }]);
  // Loops and if nesting 1+2+3+4, else-if/else/labels 1+1+2, logical chains 2+1,
  // while/do/catch 1+1+1, nested ternary 2, both switches 1+1.
  assert.deepEqual(result.cognitiveFunctions, [{ ...location, value: 24 }]);
  assert.equal(result.cognitiveComplexity, 24);
  assert.deepEqual(observations(result, 'nested-control-flow'), [[name, 12, 12, 4]]);
  assert.deepEqual(observations(result, 'boolean-logic'), [[name, 11, 11, 2], [name, 12, 12, 2]]);
  assert.deepEqual(observations(result, 'function-parameters'), [[name, 7, 36, 4]]);
  assert.deepEqual(observations(result, 'return-statements'), [[name, 7, 36, 1]]);
  assert.deepEqual(observations(result, 'function-complexity'), [[name, 7, 36, 24]]);
  assert.deepEqual(observations(result, 'file-complexity'), [[undefined, undefined, undefined, 24]]);
});

test('Java recognizes CR and CRLF lines and keeps comment markers in text blocks as code', async () => {
  const result = await parse('// Name\rclass Café {\r\n  int débit() { return 1; }\r  // More\u2028text\r'
    + '  String text = """\r    // in the string\r    /* also in the string */\r    """;\r}');
  assert.equal(result.lines, 9);
  assert.equal(result.commentLines, 2);
  assert.deepEqual(result.codeLines, [2, 3, 5, 6, 7, 8, 9]);
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'Café.débit', line: 3, column: 3, value: 1 }]);
  assert.deepEqual(result.clones?.candidates, []);
});

test('Java rejects malformed source at the first syntax issue', async () => {
  await assert.rejects(parse('class Broken {\n  void run() {\n    return\n  }\n}'),
    { name: 'SyntaxError', message: 'Expected ";" at line 3, column 11' });
});

test('Java clone candidates retain significant token spans and normalize literal kinds', async () => {
  const source = [
    'class Source {',
    '  long score(long value) {',
    '    int dec = 31;',
    '    int hex = 0xAF;',
    '    int octal = 077;',
    '    int binary = 0b101;',
    '    double real = 1.3;',
    '    double hexFloat = 0x3.0p4;',
    "    char mark = '/';",
    '    String text = "first /* comment-like */";',
    '    boolean enabled = true;',
    '    Object missing = null;',
    '    return enabled && missing == null ? value + dec + hex + octal + binary + mark : 0;',
    '  }',
    '}',
  ].join('\n');
  const result = await parse(source);
  const clones = result.clones!;
  assert.equal(clones.scheme, 'java-tokens/v1');
  const methodStart = source.indexOf('long score');
  const bodyStart = source.indexOf('{', methodStart);
  const methodEnd = source.lastIndexOf('\n}');
  // Ten five-token declarations, a 21-token return, two braces, and six further tokens in the method header.
  assert.deepEqual(clones.candidates.map(({ start, end, line, endLine, nodes, codeLines }) => [start, end, line, endLine, nodes, codeLines]), [
    [0, source.length, 1, 15, 83, 15],
    [source.indexOf('{'), source.length, 1, 15, 81, 15],
    [methodStart, methodEnd, 2, 14, 79, 13],
    [bodyStart, methodEnd, 2, 14, 73, 13],
  ]);

  const original = clones.candidates.at(-1)!;
  const bodyOf = async (text: string) => (await parse(text)).clones!.candidates.at(-1)!;
  const formatted = await bodyOf(source.replace('    int dec', '\n    /* formatting */ int  dec').replace(') {', ')   {'));
  const renamed = await bodyOf(source.replaceAll('value', 'input').replace('31', '0b11').replace('0xAF', '014')
    .replace('077', '99').replace('0b101', '0xFF').replace('1.3', '0x4.0p0').replace('0x3.0p4', '2.3')
    .replace("'/'", "'k'").replace('first /* comment-like */', 'different').replace('true', 'false'));
  const changedOperator = await bodyOf(source.replace('&&', '||'));
  const changedKind = await bodyOf(source.replace('missing = null', 'missing = text'));

  assert.equal(formatted.exact, original.exact);
  assert.equal(formatted.similar, original.similar);
  assert.notEqual(renamed.exact, original.exact);
  assert.equal(renamed.similar, original.similar);
  assert.notEqual(changedOperator.similar, original.similar);
  assert.notEqual(changedKind.similar, original.similar);
});
