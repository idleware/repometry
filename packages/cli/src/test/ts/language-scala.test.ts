import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin, { scala } from '@repometry/language-scala';

async function parse(source: readonly string[] | Uint8Array, path = 'example.scala'): Promise<CodeStructure> {
  const [operation] = plugin.create().operations;
  assert.ok(operation);
  const bytes = source instanceof Uint8Array ? source : Buffer.from([...source, ''].join('\n'));
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

function observations(structure: CodeStructure, check: StructuralObservation['check']) {
  return structure.observations?.filter(row => row.check === check);
}

const values = (structure: CodeStructure, check: StructuralObservation['check']) =>
  observations(structure, check)?.map(({ value }) => value);

test('Scala publishes its pinned parser and limits the selector to .scala', () => {
  assert.equal(plugin.id, 'language-scala');
  assert.deepEqual(plugin.tools, { 'tree-sitter-scala': '0.26.14' });
  assert.deepEqual(plugin.languages?.map(({ id, include }) => [id, include]), [['scala', ['**/*.scala']]]);
  assert.equal(scala.language.color, '#c22d40');
});

test('Scala counts concrete methods and class-like declarations with source names and positions', async () => {
  const facts = await parse([
    'package sample',
    'trait API:',
    '  def unimplemented[A](p: A): Int',
    '  def concrete: Int = 0',
    'end API',
    'class Outer(p: Int):',
    '  object Inner:',
    '    def `×`[A](a: A, b: Int = 2)(using Ordering[A], DummyImplicit): Int =',
    '      def local(x: Int)(implicit tag: Long): Int = x',
    '      val text = "🎛"; val f = (x: Int, _: String) => if x == 0 then 0 else local(x)',
    '      return 0',
    '    end `×`',
    '  def this() = this(0)',
    '  given ord: Ordering[Int] with',
    '    def compare(a: Int, b: Int) = 0',
    '  given Ordering[Long] = ???',
    '  extension (self: Int)',
    '    def plus(x: Int) = self + x',
    '  def anonymous = new API { def unimplemented[A](p: A) = 1 }',
    '  val regular = new Outer(2)',
    'end Outer',
    'case class Data(id: Int)',
    'enum E:',
    '  case A, B',
    '  case C(n: Int)',
    'package object helper { def x = () }',
  ]);
  assert.equal(facts.classes, 8);
  assert.equal(facts.functions, 10);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'API.concrete', line: 4, column: 3, value: 1 },
    { name: 'Outer.Inner.`×`', line: 8, column: 5, value: 1 },
    { name: 'Outer.Inner.`×`.local', line: 9, column: 7, value: 1 },
    { line: 10, column: 31, value: 2 },
    { name: 'Outer.this', line: 13, column: 3, value: 1 },
    { name: 'Outer.ord.compare', line: 15, column: 5, value: 1 },
    { name: 'Outer.plus', line: 18, column: 5, value: 1 },
    { name: 'Outer.anonymous', line: 19, column: 3, value: 1 },
    { name: 'Outer.anonymous.unimplemented', line: 19, column: 29, value: 1 },
    { name: 'helper.x', line: 26, column: 25, value: 1 },
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [0, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(observations(facts, 'function-parameters')?.map(({ anchor, value }) => [anchor, value]), [
    ['API.concrete', 0], ['Outer.Inner.`×`.local', 2], ['Outer.Inner.`×`.(anonymous)', 2], ['Outer.Inner.`×`', 4],
    ['Outer.this', 0], ['Outer.ord.compare', 2], ['Outer.plus', 2], ['Outer.anonymous.unimplemented', 1],
    ['Outer.anonymous', 0], ['helper.x', 0],
  ]);
  assert.deepEqual(observations(facts, 'return-statements')?.filter(({ value }) => value), [
    { check: 'return-statements', anchor: 'Outer.Inner.`×`', label: 'Outer.Inner.`×` · Return statements', line: 8, endLine: 12, value: 1 },
  ]);
});

test('Scala tracks independent explicit and case-based functions and lexical arities', async () => {
  const facts = await parse([
    'object Demo:',
    '  def top =',
    '    val empty = () => 4',
    '    val typed = { x: (Int, Int) => val local = 0; x }',
    '    val old = { implicit x => x }',
    '    val context = (x: Int) ?=> x',
    '    val polymorphic = [A] => (a: A) => a',
    '    val partial = { case 1 => 2; case _ => 3 }',
    '    val collect = List(1).collect { case x if x > 0 => x }',
    '    val other: PartialFunction[Int, Int] =',
    '      case 1 => 2',
    '      case _ => 3',
    '    val callback = (x: Int) => { if (x > 0) return x; 0 }',
    '    return 7',
    '  def usingTypes(using Foo, => Bar, Zam*): Int = 0',
  ]);
  assert.equal(facts.functions, 11);
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name, line, value }) => [name, line, value]), [
    ['Demo.top', 2, 1], [undefined, 3, 1], [undefined, 4, 1], [undefined, 5, 1], [undefined, 6, 1],
    [undefined, 7, 1], [undefined, 8, 2], [undefined, 9, 2], [undefined, 11, 2], [undefined, 13, 2],
    ['Demo.usingTypes', 15, 1],
  ]);
  assert.deepEqual(values(facts, 'function-parameters'), [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 3]);
  assert.deepEqual(observations(facts, 'return-statements')?.filter(({ value }) => value)
    .map(({ anchor, line, value }) => [anchor, line, value]), [['Demo.top.(anonymous)', 13, 1], ['Demo.top', 2, 1]]);
  assert.equal(facts.cognitiveComplexity, 2);
});

test('Scala indentation and braces preserve control-flow depth and complexity', async () => {
  const facts = await parse([
    'def byBraces(p: Boolean, q: Boolean): Int = {',
    '  if (p) 0 else if (q) { while (p) { if (q) return 1 }; 2 } else 3',
    '}',
    'def byIndentation(p: Boolean, q: Boolean): Int =',
    '  if p then 0',
    '  else',
    '    if q then',
    '      while p do',
    '        if q then return 1',
    '      2',
    '    else 3',
    'def explicitNested(p: Boolean, q: Boolean) = if p then 0 else { if q then 1 else 2 }',
  ]);
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ value }) => value), [5, 5, 3]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [8, 8, 5]);
  assert.deepEqual(values(facts, 'nested-control-flow'), [3, 3, 2]);
  assert.deepEqual(values(facts, 'return-statements'), [1, 1, 0]);
});

test('Scala counts short-circuit operator spellings and preserves arithmetic and method spelling', async () => {
  const facts = await parse([
    'def logical(a: Boolean, b: Boolean, c: Boolean, d: Boolean) = {',
    '  val total = 1 + 2 * 3',
    '  val called = a.&&(b)',
    '  if (a && (b && c) || d) 1 else 0',
    '}',
  ]);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'logical', line: 1, column: 1, value: 5 }]);
  assert.deepEqual(facts.cognitiveFunctions, [{ name: 'logical', line: 1, column: 1, value: 4 }]);
  assert.deepEqual(observations(facts, 'boolean-logic')?.map(({ line, endLine, value }) => [line, endLine, value]), [[4, 4, 3]]);
});

const flowCases = [
  ['match with alternatives, guards and a catch-all binder', [
    'subject match {', '  case 1 | 2 if p => if q then 1 else 0', '  case n @ _ => n', '}',
  ], 4, 6, 2],
  ['indented match with a constant, guarded wildcard and variable', [
    'subject match', '  case CAP => 1', '  case _ if p => 2', '  case n => n',
  ], 3, 3, 2],
  ['catch clauses, guards and finally', [
    'try 1', 'catch', '  case _: Exception if p => 2', '  case _ => 3', 'finally', '  if q then ()',
  ], 5, 4, 2],
  ['an inline catch', ['try 1 catch case _: Exception => 2'], 2, 1, 1],
  ['an expression catch', ['try 1 catch handler'], 2, 1, 1],
  ['for generators, aliases and guards', [
    'for {', '  x <- xs', '  y = x * 2', '  if y > 0', '  z <- xs', '  if z == x', '}', 'yield if p then y else z',
  ], 6, 8, 2],
  ['indented for with a case generator', [
    'for', '  case Some(x) <- xs', '  y = x * 2', '  if y > 0', '  z <- xs', '  if z == x', 'yield', '  if p then y else z',
  ], 6, 8, 2],
  ['Scala 2 do while', ['do { if (p) work() } while (q)'], 3, 3, 2],
] as const;

for (const [construct, body, cyclomatic, cognitive, depth] of flowCases) {
  test('Scala measures ' + construct, async () => {
    const facts = await parse(['def method =', ...body.map(line => '  ' + line)]);
    const position = { name: 'method', line: 1, column: 1 };
    assert.deepEqual(facts.cyclomaticFunctions, [{ ...position, value: cyclomatic }]);
    assert.deepEqual(facts.cognitiveFunctions, [{ ...position, value: cognitive }]);
    assert.equal(facts.cognitiveComplexity, cognitive);
    assert.deepEqual(values(facts, 'nested-control-flow'), [depth]);
  });
}

test('Scala counts nested comments, shebang, and comments inside interpolations without counting quoted markers', async () => {
  const lines = [
    '#!/opt/scala', '/* outer', '   /* inner */', '   outer */', 'val a = """/*', '// retained as literal text', '*/"""',
    'val b = s"""${', '  /* inside ${ } */', '  1 // mixed code and comment', '} end"""',
  ];
  const small = await parse(Buffer.from([...lines, ''].join('\r\n')));
  const large = await parse([...lines, '', 'val c = 1']);
  assert.equal(small.lines, 11);
  assert.equal(small.commentLines, 5);
  assert.deepEqual(small.codeLines, [5, 6, 7, 8, 10, 11]);
  assert.equal(large.commentLines, small.commentLines);
  assert.deepEqual(large.codeLines, [...small.codeLines!, 13]);
});

test('Scala clone tokens preserve operators and exact interpolation while abstracting identifiers and literals', async () => {
  const source = (name: string, initial: number, content: string, operator = '+', reformat = false) => [
    `def ${name}(in: Int): Int = {`, ...(reformat ? ['  // a comment', ''] : []),
    '  val title = s"' + content + ' $in"',
    ...Array.from({ length: 15 }, (_, index) => `  val a${index} = in ${operator}${reformat ? '  ' : ' '}${initial + index}`),
    '  in', '}',
  ];
  const topCandidate = async (lines: readonly string[]) => {
    const facts = await parse(lines);
    assert.equal(facts.clones?.scheme, 'scala-tokens/v1');
    assert.deepEqual(facts.clones.codeLines, facts.codeLines);
    const top = facts.clones.candidates.find(candidate => candidate.start === 0);
    assert.ok(top);
    return top;
  };
  const first = await topCandidate(source('sample', 1, 'first'));
  const reformatted = await topCandidate(source('sample', 1, 'first', '+', true));
  const renamed = await topCandidate(source('other', 2, 'first'));
  const otherContent = await topCandidate(source('sample', 1, 'second'));
  const otherOperator = await topCandidate(source('sample', 1, 'first', '-'));
  assert.deepEqual([first.line, first.endLine, first.codeLines], [1, 19, 19]);
  assert.deepEqual([reformatted.line, reformatted.endLine, reformatted.codeLines], [1, 21, 19]);
  assert.equal(first.exact, reformatted.exact);
  assert.notEqual(first.exact, renamed.exact);
  assert.notEqual(first.exact, otherContent.exact);
  assert.equal(first.similar, renamed.similar);
  assert.equal(first.similar, otherContent.similar);
  assert.notEqual(first.similar, otherOperator.similar);
  assert.deepEqual((await parse(['def small = 3'])).clones?.candidates, []);
});

test('Scala rejects strict syntax and encoding errors with .sc outside the selector', async () => {
  await assert.rejects(parse(['def broken(x: Int = {']), { name: 'SyntaxError', message: /line 1, column \d+/ });
  await assert.rejects(parse(Uint8Array.of(0xff)), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
  await assert.rejects(parse(['def valid = 1'], 'script.sc'), { message: 'No grammar for script.sc' });
});

test('Scala exposes report measurements through the registered public manifest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-scala-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'Main.scala'), '// Example\nobject Main:\n  def choose(p: Boolean) = if p then 1 else 0\n'),
    writeFile(join(directory, 'script.sc'), 'def unsupported = 1\n'),
    writeFile(join(directory, 'script.js'), 'const sample = 1;\n'),
  ]);
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: [plugin] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 2, parsed: 2 });
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'Main.scala')?.provider, 'language-scala/parse');
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'script.sc')?.provider, undefined);
  const rows = report.measurements.filter(row => row.path === 'Main.scala');
  const metrics = Object.fromEntries(rows.map(row => [row.definition, row.value]));
  assert.equal(metrics[definitions.lines], 3);
  assert.equal(metrics[definitions.codeLines], 2);
  assert.equal(metrics[definitions.comments], 1);
  assert.equal(metrics[definitions.functions], 1);
  assert.equal(metrics[definitions.classes], 1);
  assert.equal(metrics[definitions.cognitiveComplexity], 2);
  assert.deepEqual(rows.find(row => row.definition === definitions.complexity), {
    definition: definitions.complexity, target: 'function', path: 'Main.scala',
    line: 3, column: 3, name: 'Main.choose', value: 2,
  });
});
