import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { codeStructure } from '@repometry/core';
import type { CodeStructure } from '@repometry/core';
import { recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import type { RecoveryDetails, StructuralCheck } from '@repometry/core/internal/model/code-structure.js';
import plugin, { rust } from '@repometry/language-rust';

const [operation] = plugin.create().operations;
assert.ok(operation);

function recovery(facts: CodeStructure): RecoveryDetails | undefined {
  return (facts as CodeStructure & { [recoveredSyntax]?: RecoveryDetails })[recoveredSyntax];
}

const scopesSource = [
  "mod sample {",
  "    struct Unit;",
  "    struct Pair(u8, u8);",
  "    enum Mode { One, Two }",
  "    union Data { x: u32, y: f32 }",
  "    trait Readable {",
  "        fn required(&self);",
  "        fn fallback(&self) -> bool { true }",
  "    }",
  "    impl Readable for Unit {",
  "        fn required(&self) {}",
  "    }",
  "    impl Unit {",
  "        fn next(&self, value: u8) -> u8 {",
  "            let add = |n| n + 1;",
  "            add(value)",
  "        }",
  "    }",
  "    type Alias = Unit;",
  "}",
  "",
].join('\n');

const controlSource = [
  "fn choose(a: bool, b: bool, c: bool) -> i32 {",
  "    if a && b {",
  "        return 1;",
  "    } else if c {",
  "        return 2;",
  "    } else {",
  "        0",
  "    }",
  "}",
  "",
  "fn loops_and_match(items: &[u8], mode: u8) -> u8 {",
  "    for item in items {",
  "        while *item > 0 { break; }",
  "    }",
  "    loop { break; }",
  "    match mode {",
  "        1 | 2 => 2,",
  "        x if x > 10 => x,",
  "        _ if mode == 0 => 0,",
  "        _ => 1,",
  "    }",
  "}",
  "",
  "fn conditions(left: Option<i32>, right: Option<i32>) -> Option<i32> {",
  "    let Some(a) = left else { return None; };",
  "    if let Some(b) = right && b > 0 && b < 10 {",
  "        return Some(a + b);",
  "    }",
  "    Some(right? + a)",
  "}",
  "",
].join('\n');

const clonesSource = [
  "fn score(value: i32) -> i32 {",
  "    // Representative lexical tokens.",
  "    let decimal = 31;",
  "    let hex = 0xaf;",
  "    let binary = 0b101;",
  "    let ratio = 1.3;",
  "    let mark = '/';",
  "    let string = \"first\";",
  "    let raw = r###\"second\"###;",
  "    let ready = true;",
  "    let empty = false;",
  "    let tuple = (decimal, hex, binary);",
  "    let amount = value + tuple.0;",
  "    if ready && !empty {",
  "        return amount + mark as i32;",
  "    }",
  "    0",
  "}",
  "",
].join('\n');

const validNeighborSource = [
  "macro_rules! str { () => {} }",
  "",
  "struct Unit;",
  "impl Unit {",
  "    fn affected(&self) { str!(); }",
  "",
  "    fn neighbor(&self) -> bool { true }",
  "}",
  "",
].join('\n');

async function parse(source: string | Uint8Array): Promise<CodeStructure> {
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const facts = await operation!.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path: 'fixture.rs', bytes } as T;
    },
  });
  assert.ok(codeStructure.accepts(facts));
  return facts;
}

function observations(facts: CodeStructure, check: StructuralCheck) {
  return (facts.observations ?? []).filter(row => row.check === check)
    .map(({ anchor, line, endLine, value }) => [anchor, line, endLine, value]);
}

test('public manifest claims only Rust files and pins the official parser', async () => {
  assert.equal(plugin.id, 'language-rust');
  assert.deepEqual(plugin.tools, { 'tree-sitter-rust': '0.24.2' });
  assert.deepEqual(plugin.languages?.[0], {
    id: 'rust', label: 'Rust', color: '#dea584', include: ['**/*.rs'],
    measures: ['functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'commentLines', 'codeLines',
      'checks', 'duplication', 'classes'],
  });
  assert.equal(hash('sha256', await readFile(rust.asset)), '24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738');
});

test('counts declarations and qualifies methods without counting module and impl wrappers', async () => {
  const facts = await parse(scopesSource);
  assert.equal(facts.classes, 5);
  assert.equal(facts.functions, 4);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'sample.Readable.fallback', line: 8, column: 9, value: 1 },
    { name: 'sample.<Unit as Readable>.required', line: 11, column: 9, value: 1 },
    { name: 'sample.Unit.next', line: 14, column: 9, value: 1 },
    { line: 15, column: 23, value: 1 },
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(row => row.value), [0, 0, 0, 0]);
  assert.deepEqual(observations(facts, 'function-parameters').map(([anchor, , , value]) => [anchor, value]), [
    ['sample.Readable.fallback', 1], ['sample.<Unit as Readable>.required', 1],
    ['sample.Unit.next.(anonymous)', 1], ['sample.Unit.next', 2],
  ]);
  assert.equal(recovery(facts), undefined);
});

test('counts discarded closure parameters and tuple patterns once', async () => {
  const facts = await parse('fn f() { let _ = |_, x, (a, b), _: i32| x; }\n');
  assert.deepEqual(observations(facts, 'function-parameters'), [['f.(anonymous)', 1, 1, 4], ['f', 1, 1, 0]]);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'f', line: 1, column: 1, value: 1 },
    { line: 1, column: 18, value: 1 },
  ]);
});

test('measures if chains, nesting, match guards, let-else and question-mark decisions', async () => {
  const facts = await parse(controlSource);
  // if/else-if twice and one &&; three loops, two non-wildcard arms and two guards;
  // one let-else, one if, two let-chain && operators and one ?.
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name, value }) => [name, value]), [
    ['choose', 4], ['loops_and_match', 8], ['conditions', 6],
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [4, 5, 1]);
  assert.deepEqual(observations(facts, 'nested-control-flow'), [
    ['choose', 2, 8, 1], ['loops_and_match', 13, 13, 2], ['conditions', 26, 28, 1],
  ]);
  assert.deepEqual(observations(facts, 'boolean-logic'), [['choose', 2, 2, 1]]);
  assert.deepEqual(observations(facts, 'return-statements'), [
    ['choose', 1, 9, 2], ['loops_and_match', 11, 22, 0], ['conditions', 24, 30, 2],
  ]);
});

test('preserves Unicode code point columns, BOM, CRLF and nested block comments', async () => {
  const text = '\uFEFF// head\r\nfn café() { let _ = "😀"; fn naïve() {} }\r\n/* block\r\n /* nested */\r\n block */\r\n';
  const facts = await parse(text);
  assert.equal(facts.lines, 5);
  assert.equal(facts.commentLines, 4);
  assert.deepEqual(facts.codeLines, [2]);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'café', line: 2, column: 1, value: 1 },
    { name: 'café.naïve', line: 2, column: 26, value: 1 },
  ]);
});

test('fingerprints authored tokens, preserves operators and normalizes literal and identifier variants', async () => {
  const source = clonesSource;
  const facts = await parse(source);
  assert.ok(facts.clones);
  assert.equal(facts.clones.scheme, 'rust-tokens/v1');
  const end = source.length - 1;
  const candidates = facts.clones.candidates;
  assert.deepEqual(candidates.map(({ start, end, line, endLine, nodes, codeLines }) => [
    start, end, line, endLine, nodes, codeLines,
  ]), [[0, end, 1, 18, 91, 17], [28, end, 1, 18, 82, 17]]);
  const tokens = [
    '{', 'let decimal = 31 ;', 'let hex = 0xaf ;', 'let binary = 0b101 ;', 'let ratio = 1.3 ;',
    "let mark = '/' ;", 'let string = "first" ;', 'let raw = r###"second"### ;',
    'let ready = true ;', 'let empty = false ;', 'let tuple = ( decimal , hex , binary ) ;',
    'let amount = value + tuple . 0 ;', 'if ready && ! empty {', 'return amount + mark as i32 ;', '}', '0', '}',
  ].flatMap(line => line.split(' '));
  const body = candidates.at(-1);
  assert.ok(body);
  assert.equal(body.exact, hash('sha256', tokens.map(token => token.length + ':' + token).join(''), 'base64url'));
  const last = async (text: string) => {
    const candidate = (await parse(text)).clones?.candidates.at(-1);
    assert.ok(candidate);
    return candidate;
  };
  const formatted = await last(source.replace('let decimal', 'let /* formatting */  decimal'));
  assert.deepEqual([formatted.exact, formatted.similar], [body.exact, body.similar]);
  const renamed = await last(source.replaceAll('value', 'input').replace('31', '8')
    .replace('0xaf', '12').replace("'/'", "'x'").replace('1.3', '8.2')
    .replace('"first"', 'r"changed"').replace('r###"second"###', '"😀"').replace('true', 'false'));
  assert.notEqual(renamed.exact, body.exact);
  assert.equal(renamed.similar, body.similar);
  assert.notEqual((await last(source.replace('value + tuple', 'value - tuple'))).similar, body.similar);
});

test('measures intact siblings while reporting an omitted scope', async () => {
  const facts = await parse(validNeighborSource);
  assert.equal(facts.classes, 1);
  assert.equal(facts.functions, 1);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'Unit.neighbor', line: 7, column: 5, value: 1 }]);
  assert.deepEqual(recovery(facts), { reason: 'Unexpected syntax', location: 'line 5, column 29', omitted: 1 });
});

test('accepts line-only recovery without fabricated structure or clones', async () => {
  const facts = await parse('// head\nmacro_rules! str { () => {} }\nfn affected() { str!(); }\n');
  assert.equal(facts.lines, 3);
  assert.deepEqual(facts.codeLines, [2, 3]);
  assert.equal(facts.commentLines, 1);
  for (const field of ['functions', 'classes', 'cyclomaticFunctions', 'cognitiveComplexity', 'clones'] as const) {
    assert.equal(facts[field], undefined, field);
  }
  assert.deepEqual(recovery(facts), { reason: 'Unexpected syntax', location: 'line 3, column 20', omitted: 1 });
  await assert.rejects(parse(Buffer.from([0xff])), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
});

test('keeps exact and normalized clone fingerprints for a clean method in a recovered file', async () => {
  const source = clonesSource;
  const original = await parse(source);
  const prefix = 'fn affected() { str!(); }\n';
  const partial = await parse(prefix + source);
  assert.equal(partial.functions, 1);
  assert.equal(recovery(partial)?.omitted, 1);
  assert.ok(partial.clones && original.clones);
  assert.deepEqual(partial.clones.candidates, original.clones.candidates.map(candidate => ({
    ...candidate,
    start: candidate.start + prefix.length, end: candidate.end + prefix.length,
    line: candidate.line + 1, endLine: candidate.endLine + 1,
  })));
});
