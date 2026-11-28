import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import { recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import type { RecoveryDetails } from '@repometry/core/internal/model/code-structure.js';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin, { cpp } from '@repometry/language-cpp';

const defaultGlobs = ['**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.hpp', '**/*.hh'];
const packageName = '@repometry/language-cpp';
const cPackage = '@repometry/language-c';
const lines = (...source: string[]) => [...source, ''].join('\n');
const observations = (structure: CodeStructure, check: StructuralObservation['check']) =>
  structure.observations?.filter(row => row.check === check);
const values = (structure: CodeStructure, check: StructuralObservation['check']) =>
  observations(structure, check)?.map(({ value }) => value);

type NativeFacts = CodeStructure & { readonly [recoveredSyntax]?: RecoveryDetails };

async function parse(source: string | Uint8Array, path = 'example.cc'): Promise<NativeFacts> {
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

const declarations = lines(
  'namespace api::v1 {', 'class Forward;', 'struct Opaque;', 'enum class Mode { read, write };', '',
  'template<class T>', 'class Box {', '    T value{};', 'public:', '    Box() = default;',
  '    int apply(T input) const {', '        auto callback = [input]() noexcept { return input + 1; };',
  '        return callback();', '    }', '    int outlined() const;',
  '    struct Nested { int active() const { return 1; } };', '};', '', 'template<class T>',
  'int Box<T>::outlined() const { return 2; }', '', 'class Guard {', 'public:',
  '    Guard() try {} catch (...) {}', '    Guard(const Guard&) = delete;', '    ~Guard() {}', '};', '}',
);

const validNeighbor = lines(
  '#define RETURN_IF(value) if ((value)) return 1;',
  'namespace api {', 'class Choice {', 'public:', '    int affected(bool value) {', '        RETURN_IF(value)',
  '        return 0;', '    }', '    int intact(bool value) { return value ? 1 : 0; }', '};', '}',
);

test('C++ exposes definite suffixes while the provider can parse an explicit .h', async () => {
  assert.equal(plugin.id, 'language-cpp');
  assert.deepEqual(plugin.tools, { 'tree-sitter-cpp': '0.23.4' });
  assert.deepEqual(plugin.languages?.map(({ id, include }) => [id, include]), [['cpp', defaultGlobs]]);
  assert.deepEqual(cpp.language.extensions, ['.cc', '.cpp', '.cxx', '.hpp', '.hh']);
  assert.equal(cpp.recoverDeclarations, true);
  assert.equal((await parse('namespace ns {}\n', 'explicit.h')).classes, 0);
  await assert.rejects(parse('int x = 0;\n', 'other.c'), { message: 'No grammar for other.c' });
});

test('C++ measures qualified definitions, lambdas, and function-try bodies', async () => {
  const facts = await parse(declarations);
  assert.equal(facts[recoveredSyntax], undefined);
  assert.equal(facts.classes, 4);
  assert.equal(facts.functions, 6);
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'api::v1::Box.apply', line: 11, column: 5, value: 1 },
    { line: 12, column: 25, value: 1 },
    { name: 'api::v1::Box.Nested.active', line: 16, column: 21, value: 1 },
    { name: 'api::v1::Box<T>::outlined', line: 20, column: 1, value: 1 },
    { name: 'api::v1::Guard.Guard', line: 24, column: 5, value: 2 },
    { name: 'api::v1::Guard.~Guard', line: 26, column: 5, value: 1 },
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [0, 0, 0, 0, 1, 0]);
  assert.deepEqual(values(facts, 'function-parameters'), [0, 1, 0, 0, 0, 0]);
  assert.deepEqual(values(facts, 'return-statements'), [1, 1, 1, 1, 0, 0]);
});

test('C++ counts constructors, conversion operators, defaults, pointer returns and parameter packs', async () => {
  const facts = await parse(lines(
    'namespace api {', 'struct Box {', '  int n;', '  Box(int value): n(value ? value : 0) {}',
    '  explicit operator bool() const { return n != 0; }', '  Box& operator=(const Box& rhs) { return *this; }',
    '  int test(int x = 0, void (*callback)(int)=nullptr, ...) { return x; }', '};',
    'int (*factory(int a, int b))(short) { return nullptr; }',
    'template<class... Types> int packed(Types... inputs) { return sizeof...(inputs); }',
    'auto generic = []<typename T>(T x, auto... xs) -> int { return 1; };',
    'auto empty = [] { return 0; };', 'void unit(void) {}', '}',
  ));
  assert.equal(facts[recoveredSyntax], undefined);
  assert.deepEqual(facts.cyclomaticFunctions?.map(({ name, value }) => [name, value]), [
    ['api::Box.Box', 2], ['api::Box.operator bool', 1], ['api::Box.operator=', 1], ['api::Box.test', 1],
    ['api::factory', 1], ['api::packed', 1], [undefined, 1], [undefined, 1], ['api::unit', 1],
  ]);
  assert.deepEqual(values(facts, 'function-parameters'), [1, 0, 1, 3, 2, 1, 2, 0, 0]);
});

test('C++ measures range loops, exceptions, conditionals and switch without directive decisions', async () => {
  const facts = await parse(lines(
    'int control(int *range, bool a, bool b, bool c) {',
    '#if defined(F) && defined(G)', '  for(auto n : {1, 2}) { if(a and (b or c)) break; }',
    '#elif defined(H) || defined(J)', '  if(a) { return 1; } else if (b) { return 2; } else { return 3; }',
    '#endif', '  for(int i = 0; i < 2; i++) {', '    while(a) { do { goto last; } while(false); }', '  }',
    '  try { return 2; } catch (const int&) { return 1; } catch(...) { return 0; }',
    '  switch(*range) { case 1: case 2: break; default: break; }', 'last:', '  return a ? 1 : b ? 2 : 3;', '}',
  ));
  assert.equal(facts[recoveredSyntax], undefined);
  const position = { name: 'control', line: 1, column: 1 };
  assert.deepEqual(facts.cyclomaticFunctions, [{ ...position, value: 16 }]);
  assert.deepEqual(facts.cognitiveFunctions, [{ ...position, value: 21 }]);
  assert.deepEqual(observations(facts, 'boolean-logic')?.map(({ line, value }) => [line, value]), [[3, 2]]);
  assert.deepEqual(values(facts, 'nested-control-flow'), [3]);
  assert.deepEqual(values(facts, 'return-statements'), [7]);
});

test('C++ keeps lambda decisions inside the lambda and registers written coroutine returns', async () => {
  const facts = await parse(lines(
    'int f() {',
    '  auto callback = [](bool a, bool b, bool c) { if (a && b && c) return 1; return 0; };',
    '  return callback(true, false, false);', '}',
    'auto coroutine() { co_return 1; }',
  ));
  assert.deepEqual(facts.cyclomaticFunctions, [
    { name: 'f', line: 1, column: 1, value: 1 }, { line: 2, column: 19, value: 4 },
    { name: 'coroutine', line: 5, column: 1, value: 1 },
  ]);
  assert.deepEqual(facts.cognitiveFunctions?.map(({ value }) => value), [0, 2, 0]);
  assert.deepEqual(values(facts, 'return-statements'), [2, 1, 1]);
});

test('C++ classifies raw strings as code and ignores unrelated comment-only lines', async () => {
  const prefix = 'const char *label = "🎛"; ';
  const facts = await parse([
    '// a comment', '/* spanning', '   two lines */', '', 'const char *literal = R"tag(/*',
    '// raw string content', '*/)tag"; // mixed', prefix + 'int f() { return 0; }', '',
  ].join('\r\n'));
  assert.equal(facts.lines, 8);
  assert.equal(facts.commentLines, 3);
  assert.deepEqual(facts.codeLines, [5, 6, 7, 8]);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'f', line: 8, column: [...prefix].length + 1, value: 1 }]);
});

test('C++ clone tokens preserve operators and exact raw-string contents', async () => {
  const fixture = (name: string, content: string, op = '+', format = false) => lines(
    'int ' + name + '(int x) {', ...(format ? ['  /* annotation */', ''] : []), '  int total = 0;',
    '  const char *label = R"tag(' + content + ')tag";',
    ...Array.from({ length: 14 }, (_, index) => '  total = total ' + op + (format ? '  ' : ' ') + index + ' * x;'),
    '  return total;', '}',
  );
  const find = async (source: string) => {
    const facts = await parse(source);
    assert.equal(facts.clones?.scheme, 'cpp-tokens/v1');
    const candidate = facts.clones.candidates.find(item => item.start === 0);
    assert.ok(candidate);
    return candidate;
  };
  const first = await find(fixture('f', 'old'));
  const formatted = await find(fixture('f', 'old', '+', true));
  const renamed = await find(fixture('g', 'new'));
  const otherOperator = await find(fixture('f', 'old', '-'));
  assert.deepEqual([first.line, first.endLine, first.codeLines], [1, 19, 19]);
  assert.equal(first.exact, formatted.exact);
  assert.notEqual(first.exact, renamed.exact);
  assert.equal(first.similar, renamed.similar);
  assert.notEqual(first.similar, otherOperator.similar);
});

test('C++ recovery preserves an intact nested member and exposes the macro limit', async () => {
  const facts = await parse(validNeighbor);
  assert.equal(facts.classes, 0);
  assert.equal(facts.functions, 1);
  assert.deepEqual(facts.cyclomaticFunctions, [{ name: 'api::Choice.intact', line: 9, column: 5, value: 2 }]);
  assert.deepEqual(facts[recoveredSyntax], { omitted: 2, reason: 'Expected ";"', location: 'line 6, column 25' });
  const opaque = await parse(lines('#define RETURN_IF(value) if ((value)) return 1;', '',
    'int score(bool value) {', '    RETURN_IF(value);', '    return 0;', '}'));
  assert.equal(opaque[recoveredSyntax], undefined);
  assert.deepEqual(opaque.cyclomaticFunctions, [{ name: 'score', line: 3, column: 1, value: 1 }]);
});

test('C++ recovery keeps line details when definitions disappear and rejects invalid UTF-8', async () => {
  const facts = await parse(lines('/* comment */', 'int missing( {'), 'bad.hpp');
  assert.ok(facts[recoveredSyntax]);
  assert.equal(facts.classes, undefined);
  assert.equal(facts.functions, undefined);
  assert.deepEqual([facts.lines, facts.commentLines, facts.codeLines], [2, 1, [2]]);
  await assert.rejects(parse(Uint8Array.of(0xff)), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
});

test('C++ takes explicitly included headers regardless of C and C++ plugin order', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-cpp-header-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'include'));
  await Promise.all([
    writeFile(join(directory, 'include/plain.h'), 'extern int plain(void);\n'),
    writeFile(join(directory, 'include/bridge.h'), 'namespace bridge { template<class T> T copy(T x) { return x; } }\n'),
    writeFile(join(directory, 'main.cc'), validNeighbor),
    writeFile(join(directory, 'inline.hpp'), 'inline int get() { return 0; }\n'),
  ]);
  const run = (name: string, plugins: Parameters<typeof inspect>[0]['plugins']) => inspect({
    directory, output: join(directory, name), source: { workingTree: true }, plugins,
  });
  const assignment = (report: Awaited<ReturnType<typeof inspect>>) => Object.fromEntries(
    report.pluginData?.inventory?.flatMap(({ path, provider }) => provider ? [[path, provider]] : []) ?? [],
  );
  assert.deepEqual(assignment(await run('cpp', [packageName])), {
    'inline.hpp': 'language-cpp/parse', 'main.cc': 'language-cpp/parse',
  });
  const defaultAssignment = {
    'include/bridge.h': 'language-c/parse', 'include/plain.h': 'language-c/parse',
    'inline.hpp': 'language-cpp/parse', 'main.cc': 'language-cpp/parse',
  };
  assert.deepEqual(assignment(await run('both', [cPackage, packageName])), defaultAssignment);
  assert.deepEqual(assignment(await run('reverse-defaults', [packageName, cPackage])), defaultAssignment);

  const pathname = 'include/bridge.h';
  const headerOverride = { use: packageName, include: [...defaultGlobs, pathname] };
  const explicitAssignment = { ...defaultAssignment, [pathname]: 'language-cpp/parse' };
  const orders = [[cPackage, headerOverride], [headerOverride, cPackage]];
  for (const [index, plugins] of orders.entries()) {
    const report = await run('explicit-' + index, plugins);
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.scope, { files: 4, parsed: 4, recovered: 1 });
    assert.deepEqual(assignment(report), explicitAssignment);
    assert.equal(report.measurements.find(row => row.path === pathname && row.definition === definitions.functions)?.value, 1);
    assert.deepEqual(report.diagnostics.map(row => [row.path, row.operation]), [['main.cc', 'source/recovered']]);
  }
  const excluded = await run('excluded', [
    { use: packageName, include: [...defaultGlobs, pathname], exclude: [pathname] }, cPackage,
  ]);
  assert.deepEqual(assignment(excluded), defaultAssignment);
  const headerOnly = await run('header-only', [{ use: packageName, include: [pathname] }]);
  assert.deepEqual(assignment(headerOnly), { 'include/bridge.h': 'language-cpp/parse' });
});
