import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { codeStructure } from '@repometry/core';
import type { CodeStructure } from '@repometry/core';
import { recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import type { RecoveryDetails, StructuralCheck } from '@repometry/core/internal/model/code-structure.js';
import plugin, { swift } from '@repometry/language-swift';

const [operation] = plugin.create().operations;
assert.ok(operation);

function recovery(facts: CodeStructure): RecoveryDetails | undefined {
  return (facts as CodeStructure & { [recoveredSyntax]?: RecoveryDetails })[recoveredSyntax];
}

const scopesSource = [
  "protocol Readable {",
  "    func required() -> Int",
  "    var value: Int { get }",
  "}",
  "",
  "struct Record: Readable {",
  "    private var storage: Int = 1",
  "    init() {}",
  "    func required() -> Int { storage }",
  "    var value: Int { storage }",
  "    var update: Int {",
  "        get { storage }",
  "        set(updated) { storage = updated }",
  "    }",
  "    subscript(index: Int) -> Int { index + storage }",
  "}",
  "",
  "extension Record {",
  "    func increment() -> Int {",
  "        let operation = { (value: Int) in value + 1 }",
  "        let empty = {}",
  "        empty()",
  "        return operation(value)",
  "    }",
  "}",
  "",
  "enum State { case ready }",
  "actor Worker {}",
  "final class Resource {",
  "    deinit {}",
  "}",
  "",
].join('\n');

const controlSource = [
  "func choose(_ a: Bool, _ b: Bool, _ c: Bool) -> Int {",
  "    if a && b {",
  "        return 1",
  "    } else if c {",
  "        return 2",
  "    } else {}",
  "    return 0",
  "}",
  "",
  "func loopsAndSwitch(_ items: [Int], _ mode: Int) -> Int {",
  "    for item in items where item != 0 {",
  "        while item > 0 { break }",
  "    }",
  "    repeat { break } while false",
  "    switch mode {",
  "    case 1, 2: return 2",
  "    case let item where item > 10: return item",
  "    default: return 0",
  "    }",
  "}",
  "",
  "enum Fault: Error { case bad }",
  "func throwing(_ ready: Bool, _ value: Int?) -> Int {",
  "    do {",
  "        guard ready, let size = value else { throw Fault.bad }",
  "        return size > 0 ? size : 0",
  "    } catch let fault where fault is Fault {",
  "        return value ?? 1",
  "    } catch {",
  "        return 2",
  "    }",
  "}",
  "",
].join('\n');

const clonesSource = [
  "func score(_ value: Int) -> Int {",
  "    // Representative lexical tokens.",
  "    let decimal = 31",
  "    let hex = 0xaf",
  "    let binary = 0b101",
  "    let ratio = 1.3",
  "    let string = \"first\"",
  "    let raw = ####\"second\"####",
  "    let ready = true",
  "    let empty = false",
  "    let tuple = (decimal, hex, binary)",
  "    let amount = value + tuple.0",
  "    if ready && !empty {",
  "        return amount + Int(ratio) + string.count + raw.count",
  "    }",
  "    return 0",
  "}",
  "",
].join('\n');

const validNeighborSource = [
  "func consume(_ value: Void) {}",
  "",
  "struct Fixture {",
  "    func affected() {",
  "        consume(())",
  "    }",
  "    func nearby() -> Int { 7 }",
  "}",
  "",
].join('\n');

async function parse(source: string | Uint8Array): Promise<CodeStructure> {
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const facts = await operation!.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path: 'fixture.swift', bytes } as T;
    },
  });
  assert.ok(codeStructure.accepts(facts));
  return facts;
}

function observations(facts: CodeStructure, check: StructuralCheck) {
  return (facts.observations ?? []).filter(row => row.check === check)
    .map(({ anchor, line, endLine, value }) => [anchor, line, endLine, value]);
}

test('claims only Swift and pins the exact official parser', async () => {
  assert.equal(plugin.id, 'language-swift');
  assert.deepEqual(plugin.tools, { 'tree-sitter-swift': '0.7.3' });
  assert.deepEqual(plugin.languages?.[0]?.include, ['**/*.swift']);
  assert.equal(hash('sha256', await readFile(swift.asset)), '0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2');
});

test('measures types, initializers, computed accessors and closures without counting extensions or signatures', async () => {
  const facts = await parse(scopesSource);
  assert.equal(facts.classes, 5);
  assert.equal(facts.functions, 10);
  const names = [
    ['Record.init', 8, 5], ['Record.required', 9, 5], ['Record.value.get', 10, 20],
    ['Record.update.get', 12, 9], ['Record.update.set', 13, 9],
    ['Record.subscript.get', 15, 34], ['Record.increment', 19, 5],
    [undefined, 20, 25], [undefined, 21, 21], ['Resource.deinit', 30, 5],
  ];
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name, line, column }) => [name, line, column]), names);
  assert.ok(facts.cyclomaticFunctions?.every(row => row.value === 1));
  assert.ok(facts.cognitiveFunctions?.every(row => row.value === 0));
  assert.deepEqual(observations(facts, 'function-parameters'), [
    ['Record.init', 8, 8, 0], ['Record.required', 9, 9, 0], ['Record.value.get', 10, 10, 0],
    ['Record.update.get', 12, 12, 0], ['Record.update.set', 13, 13, 1], ['Record.subscript.get', 15, 15, 1],
    ['Record.increment.(anonymous)', 20, 20, 1], ['Record.increment.(anonymous)', 21, 21, 0],
    ['Record.increment', 19, 24, 0], ['Resource.deinit', 30, 30, 0],
  ]);
});

test('counts if chains, guard conditions, switch guards, loops, catches and explicit returns', async () => {
  const facts = await parse(controlSource);
  // Two ifs and one &&. Three loops, a for where, two cases and one case where.
  // Guard plus its second condition, ternary, two catches, one where and one ??.
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name, value }) => [name, value]), [
    ['choose', 4], ['loopsAndSwitch', 8], ['throwing', 8],
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(row => row.value), [4, 5, 4]);
  assert.deepEqual(observations(facts, 'boolean-logic'), [['choose', 2, 2, 1]]);
  assert.deepEqual(observations(facts, 'nested-control-flow'), [
    ['choose', 2, 6, 1], ['loopsAndSwitch', 12, 12, 2], ['throwing', 25, 25, 1],
  ]);
  assert.deepEqual(observations(facts, 'return-statements'), [
    ['choose', 1, 8, 3], ['loopsAndSwitch', 10, 20, 3], ['throwing', 23, 32, 3],
  ]);
});

test('preserves authored conditional branches and excludes compilation conditions from runtime decisions', async () => {
  const source = [
    'func source() -> Int {', '#if DEBUG && !TEST', ' if true { return 1 }',
    '#else', ' if false { return 2 }', '#endif', ' return 0', '}', '',
  ].join('\n');
  const facts = await parse(source);
  assert.equal(recovery(facts), undefined);
  assert.equal(facts.cyclomaticFunctions?.[0]?.value, 3);
  assert.equal(facts.cognitiveFunctions?.[0]?.value, 2);
  assert.deepEqual(observations(facts, 'boolean-logic'), []);
  assert.deepEqual(observations(facts, 'return-statements'), [['source', 1, 8, 3]]);
});

test('uses Unicode code point columns and physical lines with BOM, CRLF and nested comments', async () => {
  const text = '\uFEFF// header\r\nfunc café() { let _ = "😀"; func naïve() {} }\r\n/* block\r\n /* nested */\r\n block */\r\n';
  const facts = await parse(text);
  assert.equal(facts.lines, 5);
  assert.equal(facts.commentLines, 4);
  assert.deepEqual(facts.codeLines, [2]);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'café', line: 2, column: 1, value: 1 },
    { name: 'café.naïve', line: 2, column: 28, value: 1 },
  ]);
});

test('pins clone spans, exact token hashes and interpolation-sensitive similar hashes', async () => {
  const source = clonesSource;
  const facts = await parse(source);
  assert.ok(facts.clones);
  assert.equal(facts.clones.scheme, 'swift-tokens/v1');
  const candidates = facts.clones.candidates;
  assert.deepEqual(candidates.map(({ start, end, line, endLine, nodes, codeLines }) => [
    start, end, line, endLine, nodes, codeLines,
  ]), [[0, 433, 1, 17, 88, 16], [32, 433, 1, 17, 78, 16], [76, 431, 3, 16, 76, 14]]);
  const tokens = [
    '{', 'let decimal = 31', 'let hex = 0xaf', 'let binary = 0b101', 'let ratio = 1.3',
    'let string = " first "', 'let raw = ####"second"####', 'let ready = true', 'let empty = false',
    'let tuple = ( decimal , hex , binary )', 'let amount = value + tuple . 0',
    'if ready && ! empty {', 'return amount + Int ( ratio ) + string . count + raw . count', '}', 'return 0', '}',
  ].flatMap(line => line.split(' '));
  const body = candidates[1];
  assert.ok(body);
  assert.equal(body.exact, hash('sha256', tokens.map(token => token.length + ':' + token).join(''), 'base64url'));
  const bodyOf = async (text: string) => {
    const candidate = (await parse(text)).clones?.candidates[1];
    assert.ok(candidate);
    return candidate;
  };
  const formatted = await bodyOf(source.replace('let decimal', 'let /* formatting */  decimal'));
  assert.deepEqual([formatted.exact, formatted.similar], [body.exact, body.similar]);
  const changed = await bodyOf(source.replaceAll('value', 'data').replace('31', '8').replace('0xaf', '12')
    .replace('1.3', '8.2').replace('"first"', '"text"').replace('second', 'new').replace('true', 'false'));
  assert.notEqual(changed.exact, body.exact);
  assert.equal(changed.similar, body.similar);

  const interpolation = source.replace('"first"', '"first \\(decimal + value)"');
  const interpolated = await bodyOf(interpolation);
  assert.equal((await bodyOf(interpolation.replace('first ', 'changed '))).similar, interpolated.similar);
  assert.notEqual((await bodyOf(interpolation.replace('decimal + value', 'decimal - value'))).similar, interpolated.similar);
});

test('recovers a clean named neighbor beside a compiler-valid Swift expression the grammar rejects', async () => {
  const facts = await parse(validNeighborSource);
  assert.equal(facts.classes, 0);
  assert.equal(facts.functions, 2);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'consume', line: 1, column: 1, value: 1 }, { name: 'Fixture.nearby', line: 7, column: 5, value: 1 },
  ]);
  assert.deepEqual(recovery(facts), { reason: 'Expected "!"', location: 'line 5, column 18', omitted: 2 });
});

test('keeps only line facts when recovery has no measurable declarations', async () => {
  const facts = await parse('func affected() {\n  consume(())\n}\n');
  assert.deepEqual(facts.codeLines, [1, 2, 3]);
  assert.equal(facts.lines, 3);
  assert.equal(facts.commentLines, 0);
  for (const field of ['functions', 'classes', 'cyclomaticFunctions', 'cognitiveComplexity', 'clones'] as const) {
    assert.equal(facts[field], undefined, field);
  }
  assert.deepEqual(recovery(facts), { reason: 'Expected "!"', location: 'line 2, column 12', omitted: 1 });
  await assert.rejects(parse(Buffer.from([0xff])), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
});

test('preserves mixed short-circuit sequences through a parenthesized operand', async () => {
  const facts = await parse([
    'func chain(_ a: Bool, _ b: Bool, _ c: Bool, _ d: Bool) {',
    '  if (a && b && c) || d {}',
    '}', '',
  ].join('\n'));
  assert.equal(facts.cyclomaticFunctions?.[0]?.value, 5);
  assert.equal(facts.cognitiveFunctions?.[0]?.value, 3);
  assert.deepEqual(observations(facts, 'boolean-logic'), [['chain', 2, 2, 3]]);
});
