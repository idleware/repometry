import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import plugin from '@repometry/language-kotlin';
import { parseNative } from './helpers/parse-native.js';

const parse = (source: string, path = 'Example.kt') => parseNative(plugin, source, path);

function observations(structure: CodeStructure, check: StructuralObservation['check']) {
  return structure.observations?.filter(item => item.check === check).map(({ anchor, line, endLine, value }) =>
    [anchor, line, endLine, value]);
}

test('Kotlin locates functions, constructors, accessors and lambdas in named scopes', async () => {
  const result = await parse([
    'interface Contract {', '  fun work(n: Int): Int', '}',
    'class Gate(private val threshold: Int) : Contract {',
    '  private var calls = 0', '    get() { return field }', '    set(value) { field = value }',
    '  constructor() : this(1) {}',
    '  override fun work(n: Int): Int {',
    '    fun check(v: Int = 1): Int = if (v > 0) v else threshold',
    '    val f = fun(v: Int): Int { return v + 1 }',
    '    val g: (Int, Int) -> Int = { a, b -> if (a > b) a else b }',
    '    val badge = "🎛"; val h: () -> Int = { 1 }',
    '    return g(check(n), f(h()))', '  }',
    '  companion object {', '    fun make() = Gate()', '  }', '}',
    'object Service {', '  fun ping() {}', '}', '',
  ].join('\r\n'));
  assert.equal(result.classes, 4);
  assert.equal(result.functions, 10);
  assert.deepEqual(result.cyclomaticFunctions, [
    { name: 'Gate.calls.get', line: 6, column: 5, value: 1 },
    { name: 'Gate.calls.set', line: 7, column: 5, value: 1 },
    { name: 'Gate.constructor', line: 8, column: 3, value: 1 },
    { name: 'Gate.work', line: 9, column: 3, value: 1 },
    { name: 'Gate.work.check', line: 10, column: 5, value: 2 },
    { line: 11, column: 13, value: 1 },
    { line: 12, column: 32, value: 2 },
    { line: 13, column: 41, value: 1 },
    { name: 'Gate.Companion.make', line: 17, column: 5, value: 1 },
    { name: 'Service.ping', line: 21, column: 3, value: 1 },
  ]);
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['Gate.calls.get', 6, 6, 0], ['Gate.calls.set', 7, 7, 1], ['Gate.constructor', 8, 8, 0],
    ['Gate.work.check', 10, 10, 1],
    ['Gate.work.(anonymous)', 11, 11, 1], ['Gate.work.(anonymous)', 12, 12, 2],
    ['Gate.work.(anonymous)', 13, 13, 0], ['Gate.work', 9, 15, 1],
    ['Gate.Companion.make', 17, 17, 0], ['Service.ping', 21, 21, 0],
  ]);
  assert.deepEqual(observations(result, 'return-statements'), [
    ['Gate.calls.get', 6, 6, 1], ['Gate.calls.set', 7, 7, 0], ['Gate.constructor', 8, 8, 0],
    ['Gate.work.check', 10, 10, 0],
    ['Gate.work.(anonymous)', 11, 11, 1], ['Gate.work.(anonymous)', 12, 12, 0],
    ['Gate.work.(anonymous)', 13, 13, 0], ['Gate.work', 9, 15, 1],
    ['Gate.Companion.make', 17, 17, 0], ['Service.ping', 21, 21, 0],
  ]);
  assert.equal(result.cognitiveComplexity, 4);
});

test('Kotlin counts enum and anonymous object bodies and measures constructor delegation', async () => {
  const result = await parse([
    'enum class State {', '  ACTIVE, IDLE;', '  fun label() = name', '}',
    'class Parent(val state: State) {',
    '  constructor(active: Boolean) : this(if (active) State.ACTIVE else State.IDLE)',
    '  val listener = object {', '    fun call() { return }', '  }', '}', '',
  ].join('\n'));
  assert.equal(result.classes, 3);
  assert.equal(result.functions, 3);
  assert.deepEqual(result.cyclomaticFunctions, [
    { name: 'State.label', line: 3, column: 3, value: 1 },
    { name: 'Parent.constructor', line: 6, column: 3, value: 2 },
    { name: 'Parent.call', line: 8, column: 5, value: 1 },
  ]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['Parent.constructor', 6, 6, 1]]);
  assert.equal(result.cognitiveComplexity, 2);
});

test('Kotlin counts declared parameters and keeps default-value branches in the enclosing scope', async () => {
  const result = await parse([
    'fun String.pick(index: Int = if (isEmpty()) 0 else 1, vararg values: Int): Int {',
    '  val unpack: (Pair<Int, Int>, Int) -> Int = read@{ (left, right), weight ->',
    '    return@read left * weight + right',
    '  }',
    '  val bump: (Int) -> Int = { it + 1 }',
    '  return unpack(index to values.size, bump(2))', '}', '',
  ].join('\n'));
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['pick.(anonymous)', 2, 4, 2], ['pick.(anonymous)', 5, 5, 0], ['pick', 1, 7, 2],
  ]);
  assert.deepEqual(observations(result, 'return-statements'), [
    ['pick.(anonymous)', 2, 4, 1], ['pick.(anonymous)', 5, 5, 0], ['pick', 1, 7, 1],
  ]);
  assert.deepEqual(result.cyclomaticFunctions?.map(item => item.value), [1, 1, 1]);
  assert.equal(result.cognitiveComplexity, 2);
  assert.deepEqual(observations(result, 'nested-control-flow'), [[undefined, 1, 1, 1]]);
});

const flowCases = [
  ['if and else if', ['if (first) useFirst() else if (second) useSecond() else fallback()'], 3, 3, 1],
  ['an else block with nested flow', ['if (ready) work() else {', '  while (ready) work()', '}'], 3, 4, 2],
  ['an empty else', ['if (ready) work() else;'], 2, 2, 1],
  ['nested for, while and do-while', ['for (job in jobs) {', '  while (ready) {', '    do {', '      job.run()',
    '    } while (!done)', '  }', '}'], 4, 6, 3],
  ['when arms', ['when (kind) {', '  1, 2 -> heat()', '  in 3..4 -> chill()', '  is Int -> mix()', '  else -> rest()', '}'], 4, 1, 1],
  ['catch and finally', ['try {', '  work()', '} catch (bad: IllegalArgumentException) {', '  repair()',
    '} catch (bad: IllegalStateException) {', '  postpone()', '} finally {', '  close()', '}'], 3, 2, 1],
  ['Elvis', ['val selected = choice ?: fallback'], 2, 0, 0],
  ['loop exits', ['jobsLoop@ for (job in jobs) {', '  if (paused) continue@jobsLoop',
    '  if (done) break@jobsLoop', '}'], 4, 5, 2],
] as const;

for (const [construct, body, cyclomatic, cognitive, depth] of flowCases) {
  test('Kotlin measures ' + construct, async () => {
    const result = await parse(['fun runJob() {', ...body.map(line => '  ' + line), '}', ''].join('\n'));
    const position = { name: 'runJob', line: 1, column: 1 };
    assert.deepEqual(result.cyclomaticFunctions, [{ ...position, value: cyclomatic }]);
    assert.deepEqual(result.cognitiveFunctions, [{ ...position, value: cognitive }]);
    assert.equal(result.cognitiveComplexity, cognitive);
    assert.deepEqual(result.observations?.filter(item => item.check === 'nested-control-flow')
      .map(({ anchor, value }) => [anchor, value]), depth ? [['runJob', depth]] : []);
  });
}

test('Kotlin locates grouped boolean expressions and the deepest flow', async () => {
  const result = await parse([
    'fun route(a: Boolean, b: Boolean, c: Boolean, d: Boolean) {',
    '  if ((a && b) && c || d) {', '    while (a || (b && c)) {', '      return', '    }', '  }', '}',
    'if (delayed) fallback()', '',
  ].join('\n'), 'Example.kts');
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'route', line: 1, column: 1, value: 8 }]);
  assert.deepEqual(result.cognitiveFunctions, [{ name: 'route', line: 1, column: 1, value: 7 }]);
  assert.equal(result.cognitiveComplexity, 8);
  assert.deepEqual(observations(result, 'boolean-logic'), [['route', 2, 2, 3], ['route', 3, 3, 2]]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['route', 3, 5, 2], [undefined, 8, 8, 1]]);
  assert.deepEqual(observations(result, 'file-complexity'), [[undefined, undefined, undefined, 8]]);
});

test('Kotlin counts script shebangs and nested block comments while keeping raw string content', async () => {
  const result = await parse([
    '#!/usr/bin/env kotlin', '/* Outer', '  /* Nested */', '  still outer', '*/', '',
    'val status = """', '  // literal text', '  /* literal text */', '""" // inline note',
    '// closing note', '',
  ].join('\n'), 'Example.kts');
  assert.equal(result.lines, 11);
  assert.equal(result.commentLines, 6);
  assert.deepEqual(result.codeLines, [7, 8, 9, 10]);
  assert.equal(result.functions, 0);
});

test('Kotlin clone hashes retain operators and normalize changed names and literals', async () => {
  const source = (name: string, variable: string, first: number, symbol = '+', comment = '') => [
    'fun ' + name + '(input: Int): Int {', ...(comment ? [comment, ''] : []),
    '  var ' + variable + ' = 0',
    ...Array.from({ length: 12 }, (_, index) => '  ' + variable + ' += input ' + symbol + ' ' + (first + index)),
    '  return ' + variable, '}', '',
  ].join('\n');
  const fingerprints = async (text: string) => {
    const result = await parse(text);
    assert.equal(result.clones?.scheme, 'kotlin-tokens/v1');
    const definition = result.clones.candidates.find(item => item.start === 0);
    assert.ok(definition);
    return definition;
  };
  const original = await fingerprints(source('first', 'total', 1));
  const formatted = await fingerprints(source('first', 'total', 1, '+', '  // note'));
  const renamed = await fingerprints(source('second', 'sum', 19));
  const withDifferentOperator = await fingerprints(source('first', 'total', 1, '*'));
  assert.deepEqual([original.line, original.endLine, original.codeLines], [1, 16, 16]);
  assert.deepEqual([formatted.endLine, formatted.codeLines], [18, 16]);
  assert.equal(original.exact, formatted.exact);
  assert.equal(original.similar, formatted.similar);
  assert.notEqual(original.exact, renamed.exact);
  assert.equal(original.similar, renamed.similar);
  assert.notEqual(original.similar, withDifferentOperator.similar);
  const result = await parse(source('first', 'total', 1));
  assert.ok(result.clones?.candidates.some(item => item.start === 27 && item.line === 1 && item.nodes < original.nodes));
  assert.deepEqual((await parse('fun short() = 1\n')).clones?.candidates, []);
});

test('Kotlin clone hashes distinguish literal types from identifiers', async () => {
  const fingerprint = async (value: string) => {
    const text = ['fun flags() {', ...Array.from({ length: 13 }, (_, index) => '  val flag' + index + ' = ' + value),
      '}'].join('\n');
    const result = await parse(text);
    const clone = result.clones?.candidates.find(item => item.start === 0);
    assert.ok(clone);
    return clone.similar;
  };
  const bool = await fingerprint('true');
  assert.equal(bool, await fingerprint('false'));
  assert.notEqual(bool, await fingerprint('null'));
  assert.notEqual(bool, await fingerprint('flag'));
});

test('Kotlin reports a source location for malformed syntax', async () => {
  await assert.rejects(parse('fun missing(\n'), { name: 'SyntaxError', message: /line 1, column [0-9]+/ });
});
