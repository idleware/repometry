import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import { recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import type { RecoveryDetails } from '@repometry/core/internal/model/code-structure.js';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin, { c } from '@repometry/language-c';

type NativeFacts = CodeStructure & { readonly [recoveredSyntax]?: RecoveryDetails };

async function parse(source: string | Uint8Array, path = 'example.c'): Promise<NativeFacts> {
  const [operation] = plugin.create().operations;
  assert.ok(operation);
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const facts = await operation.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path, bytes } as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(facts));
  return facts;
}

const lines = (...source: string[]) => [...source, ''].join('\n');
const observations = (structure: CodeStructure, check: StructuralObservation['check']) =>
  structure.observations?.filter(row => row.check === check);
const values = (structure: CodeStructure, check: StructuralObservation['check']) =>
  observations(structure, check)?.map(({ value }) => value);

const declarations = lines(
  'struct Forward;',
  'enum Tag { TAG };',
  'typedef struct A {',
  '    union U { int first; long second; } member;',
  '} A;',
  'typedef struct { int value; } Anonymous;',
  'struct Forward *only_reference;',
  'int prototype(int);',
  'typedef int Callback(int);',
  'static int target(int x) { return x; }',
  'int (*factory(void))(int) { return target; }',
);

const validNeighbor = lines(
  '#define NORETURN /* language-level annotation in an ordinary build */',
  '',
  'int damaged(int value NORETURN)',
  '{',
  '    return value + 1;',
  '}',
  '',
  'struct Forward;',
  'typedef struct Record {',
  '    int value;',
  '} Record;',
  '',
  'int nearby(int value)',
  '{',
  '    return value;',
  '}',
);

test('C opts into tolerant measurement for .c and .h', () => {
  assert.equal(plugin.id, 'language-c');
  assert.deepEqual(plugin.tools, { 'tree-sitter-c': '0.24.2' });
  assert.deepEqual(plugin.languages?.map(({ id, include }) => [id, include]), [['c', ['**/*.c', '**/*.h']]]);
  assert.equal(c.recoverDeclarations, true);
});

test('C counts only complete function, struct, union, and enum definitions', async () => {
  for (const path of ['source.c', 'header.h']) {
    const facts = await parse(declarations, path);
    assert.equal(facts[recoveredSyntax], undefined);
    assert.equal(facts.classes, 4);
    assert.equal(facts.functions, 2);
    assert.deepEqual(facts.cyclomaticFunctions, [
      { name: 'target', line: 10, column: 1, value: 1 }, { name: 'factory', line: 11, column: 1, value: 1 },
    ]);
    assert.deepEqual(values(facts, 'function-parameters'), [1, 0]);
    assert.deepEqual(values(facts, 'return-statements'), [1, 1]);
  }
  const header = await parse(lines('#define COUNT 10', 'struct Forward;', 'extern int onlyPrototype(void);'), 'empty.h');
  assert.equal(header[recoveredSyntax], undefined);
  assert.equal(header.functions, 0);
  assert.equal(header.classes, 0);
});

test('C parameters follow the closest declarator, including old-style and variadic forms', async () => {
  const facts = await parse(lines(
    'int (*factory(int selector, const char *path))(int target) { return 0; }',
    'static int walk(int x[static 2], int (*callback)(int, int), ...) { return 0; }',
    'int old(a, b)', 'int a;', 'int b;', '{ return a + b; }',
    'void none(void) { }',
  ));
  assert.equal(facts[recoveredSyntax], undefined);
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name }) => name), ['factory', 'walk', 'old', 'none']);
  assert.deepEqual(values(facts, 'function-parameters'), [2, 3, 2, 0]);
  assert.deepEqual(values(facts, 'return-statements'), [1, 1, 1, 0]);
});

test('C measures executable flow in authored branches and ignores preprocessor conditions', async () => {
  const facts = await parse(lines(
    'int method(int x, int z) {',
    '#if defined(A) && defined(B)', '  if (x && z) goto done;',
    '#elif defined(C) || defined(D)', '  if (z) return x;',
    '#else', '  x += z;', '#endif',
    '  if (x > z) return x;',
    '  else if (x < z) return z;',
    '  else { while (z) { if (x) break; } }',
    '  switch (x) { case 0: case 1: return 1; default: if (z) return 0; }',
    '  for (; x; ++x) { do { x--; } while (z); }',
    '  done:', '  return x ? 1 : 0;',
    '}',
  ));
  assert.equal(facts[recoveredSyntax], undefined);
  const position = { name: 'method', line: 1, column: 1 };
  assert.deepEqual(facts.cyclomaticFunctions, [{ ...position, value: 14 }]);
  assert.deepEqual(facts.cognitiveFunctions, [{ ...position, value: 19 }]);
  assert.deepEqual(values(facts, 'nested-control-flow'), [3]);
  assert.deepEqual(values(facts, 'return-statements'), [6]);
  assert.deepEqual(observations(facts, 'boolean-logic')?.map(({ line, value }) => [line, value]), [[3, 1]]);
});

test('C groups logic sequences and gives default no extra switch point', async () => {
  const facts = await parse(lines(
    'int logical(int a, int b, int c, int d) { if (a && (b && c) || d) return a; return b; }',
    'int without_default(int x) { switch (x) { case 1: return 1; case 2: return 2; } return 0; }',
    'int with_default(int x) { switch (x) { case 1: return 1; case 2: return 2; default: return 0; } }',
  ));
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ value }) => value), [5, 3, 3]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [3, 1, 1]);
  assert.deepEqual(values(facts, 'boolean-logic'), [3]);
  assert.deepEqual(values(facts, 'nested-control-flow'), [1, 1, 1]);
});

test('C reports code point positions, CRLF lines and comment-only lines', async () => {
  const prefix = 'const char *label = "🎛"; ';
  const facts = await parse([
    '// separately commented', '/* spanning', '   two lines */', '',
    'const char *literal = "/* this is text */"; // mixed', prefix + 'int f(void) { return 0; }', '',
  ].join('\r\n'));
  assert.equal(facts.lines, 6);
  assert.equal(facts.commentLines, 3);
  assert.deepEqual(facts.codeLines, [5, 6]);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'f', line: 6, column: [...prefix].length + 1, value: 1 }]);
});

test('C clone tokens preserve operators and normalize identifiers and literals', async () => {
  const fixture = (name: string, first: number, operator = '+', format = false) => lines(
    'int ' + name + '(int x) {', ...(format ? ['  /* annotation */', ''] : []), '  int total = 0;',
    ...Array.from({ length: 16 }, (_, index) => '  total = total ' + operator + (format ? '  ' : ' ') + (first + index) + ' * x;'),
    '  return total;', '}',
  );
  const firstCandidate = async (source: string) => {
    const facts = await parse(source);
    assert.equal(facts.clones?.scheme, 'c-tokens/v1');
    const candidate = facts.clones.candidates.find(item => item.start === 0);
    assert.ok(candidate);
    return candidate;
  };
  const first = await firstCandidate(fixture('sample', 1));
  const formatted = await firstCandidate(fixture('sample', 1, '+', true));
  const renamed = await firstCandidate(fixture('other', 19));
  const otherOperator = await firstCandidate(fixture('sample', 1, '-'));
  assert.deepEqual([first.line, first.endLine, first.codeLines], [1, 20, 20]);
  assert.deepEqual([formatted.endLine, formatted.codeLines], [22, 20]);
  assert.equal(first.exact, formatted.exact);
  assert.notEqual(first.exact, renamed.exact);
  assert.equal(first.similar, renamed.similar);
  assert.notEqual(first.similar, otherOperator.similar);
});

test('C drops a damaged function and keeps valid neighbors with original positions', async () => {
  const facts = await parse(validNeighbor);
  assert.equal(facts.classes, 1);
  assert.equal(facts.functions, 1);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'nearby', line: 13, column: 1, value: 1 }]);
  assert.deepEqual(values(facts, 'return-statements'), [1]);
  assert.equal(facts[recoveredSyntax]?.omitted, 1);
  assert.equal(facts[recoveredSyntax]?.location, 'line 3, column 22');
  assert.equal(facts.clones?.scheme, 'c-tokens/v1');
});

test('C keeps physical facts when no declaration survives and rejects non-UTF-8', async () => {
  const facts = await parse(lines('/* comment */', 'int missing( {'), 'bad.h');
  assert.ok(facts[recoveredSyntax]);
  assert.equal(facts.functions, undefined);
  assert.equal(facts.classes, undefined);
  assert.equal(facts.clones, undefined);
  assert.deepEqual([facts.lines, facts.commentLines, facts.codeLines], [2, 1, [2]]);
  await assert.rejects(parse(Uint8Array.of(0xff)), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
  await assert.rejects(parse(lines('int sample(void) { return 0; }'), 'sample.cpp'), { message: 'No grammar for sample.cpp' });
});

test('explicit C manifest surfaces recovered declarations and keeps plain headers selectable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-c-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'sample.c'), validNeighbor),
    writeFile(join(directory, 'plain.h'), declarations),
    writeFile(join(directory, 'exclude.cpp'), 'int unaffected() { return 1; }\n'),
  ]);
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: ['@repometry/language-c'] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 2, parsed: 2, recovered: 1 });
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'plain.h')?.provider, 'language-c/parse');
  const byMetric = (path: string) => Object.fromEntries(report.measurements.filter(row => row.path === path)
    .map(row => [row.definition, row.value]));
  assert.equal(byMetric('plain.h')[definitions.classes], 4);
  assert.equal(byMetric('sample.c')[definitions.functions], 1);
  assert.equal(report.diagnostics[0]?.operation, 'source/recovered');
  assert.match(report.diagnostics[0]!.message, /line 3, column 22\. Declarations omitted: 1\./);
});
