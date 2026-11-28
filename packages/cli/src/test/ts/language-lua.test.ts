import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import plugin, { lua } from '@repometry/language-lua';
import { parseNative } from './helpers/parse-native.js';

const parse = (source: string, path = 'example.lua') => parseNative(plugin, source, path);

function observations(structure: CodeStructure, check: StructuralObservation['check']) {
  return structure.observations?.filter(item => item.check === check).map(({ anchor, line, endLine, value }) =>
    [anchor, line, endLine, value]);
}

test('Lua declares the .lua suffix and its grammar version', () => {
  assert.equal(plugin.id, 'language-lua');
  assert.deepEqual(plugin.tools, { '@tree-sitter-grammars/tree-sitter-lua': '0.5.0' });
  assert.deepEqual(plugin.languages?.map(({ id, include }) => [id, include]), [['lua', ['**/*.lua']]]);
  assert.ok(lua.language.syntax?.lineComments?.includes('--'));
});

test('Lua qualifies named scopes, locates anonymous functions, and counts varargs and returns', async () => {
  const result = await parse([
    'local function top(value, ...)', '  local function inner(keep)', '    if keep then return value end',
    '    return nil', '  end', '  local text = "🎛"; local callback = function(ignored) return ignored end',
    '  return inner(value), callback', 'end', 'function lib . network : connect(port, ...opts)', '  return port', 'end',
    'global function published() end', 'function p . audit() end', '',
  ].join('\r\n'));
  assert.equal(result.functions, 6);
  assert.equal(result.classes, undefined);
  assert.deepEqual(result.cyclomaticFunctions, [
    { name: 'top', line: 1, column: 1, value: 1 },
    { name: 'top.inner', line: 2, column: 3, value: 2 },
    { line: 6, column: 38, value: 1 },
    { name: 'lib.network:connect', line: 9, column: 1, value: 1 },
    { name: 'published', line: 12, column: 1, value: 1 },
    { name: 'p.audit', line: 13, column: 1, value: 1 },
  ]);
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['top.inner', 2, 5, 1], ['top.(anonymous)', 6, 6, 1], ['top', 1, 8, 2],
    ['lib.network:connect', 9, 11, 2], ['published', 12, 12, 0], ['p.audit', 13, 13, 0],
  ]);
  assert.deepEqual(observations(result, 'return-statements'), [
    ['top.inner', 2, 5, 2], ['top.(anonymous)', 6, 6, 1], ['top', 1, 8, 1],
    ['lib.network:connect', 9, 11, 1], ['published', 12, 12, 0], ['p.audit', 13, 13, 0],
  ]);
  assert.deepEqual(result.cognitiveFunctions?.map(({ value }) => value), [0, 1, 0, 0, 0, 0]);
});

const flowCases = [
  ['if and elseif', ['if first then', '  use_first()', 'elseif second then', '  use_second()',
    'elseif third then', '  use_third()', 'else', '  fallback()', 'end'], 4, 4, 1],
  ['a loop in the final alternative', ['if first then use_first() elseif second then use_second() else',
    '  while ready do work() end', 'end'], 4, 5, 2],
  ['numeric and generic for and repeat', ['for index = 1, 3 do', '  for key, value in pairs(values) do',
    '    repeat', '      work()', '    until done', '  end', 'end'], 4, 6, 3],
  ['while and break', ['while ready do', '  if done then break end', 'end'], 3, 3, 2],
  ['a lexical do block', ['do if ready then work() end end'], 2, 1, 1],
  ['a labeled goto', ['goto done', '::done::', 'return 1'], 1, 1, 0],
] as const;

for (const [construct, body, cyclomatic, cognitive, depth] of flowCases) {
  test('Lua measures ' + construct, async () => {
    const result = await parse(['function run_job()', ...body.map(line => '  ' + line), 'end', ''].join('\n'));
    const position = { name: 'run_job', line: 1, column: 1 };
    assert.deepEqual(result.cyclomaticFunctions, [{ ...position, value: cyclomatic }]);
    assert.deepEqual(result.cognitiveFunctions, [{ ...position, value: cognitive }]);
    assert.equal(result.cognitiveComplexity, cognitive);
    assert.deepEqual(result.observations?.filter(item => item.check === 'nested-control-flow')
      .map(({ anchor, value }) => [anchor, value]), depth ? [['run_job', depth]] : []);
  });
}

test('Lua locates grouped boolean expressions and nested control flow', async () => {
  const result = await parse([
    'function route(a, b, c, d)', '  if (a and b) and c or d then', '    while a or (b and c) do',
    '      return d', '    end', '  end', 'end', 'if delayed then fallback() end', '',
  ].join('\n'));
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'route', line: 1, column: 1, value: 8 }]);
  assert.deepEqual(result.cognitiveFunctions, [{ name: 'route', line: 1, column: 1, value: 7 }]);
  assert.equal(result.cognitiveComplexity, 8);
  assert.deepEqual(observations(result, 'boolean-logic'), [['route', 2, 2, 3], ['route', 3, 3, 2]]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['route', 3, 5, 2], [undefined, 8, 8, 1]]);
});

test('Lua counts a shebang and long comments and retains long strings as code', async () => {
  const result = await parse([
    '#!/usr/bin/env lua', '-- A note', '--[=[', '', 'Long comment', ']=]', '',
    'local text = [=[', '-- This is string content', ']=] -- An inline comment',
    'local number = 1 -- Another inline comment', '',
  ].join('\r\n'));
  assert.equal(result.lines, 11);
  assert.equal(result.commentLines, 6);
  assert.deepEqual(result.codeLines, [8, 9, 10, 11]);
  assert.equal(result.functions, 0);
});

test('Lua measures clones of function declarations, bodies, and tables', async () => {
  const source = (name: string, variable: string, first: number, operator = '+', formatted = false) => [
    'local function ' + name + '(subject)', ...(formatted ? ['  -- A note', ''] : []), '  local ' + variable + ' = 0',
    ...Array.from({ length: 18 }, (_, index) => '  ' + variable + ' = ' + variable
      + (formatted ? '  ' : ' ') + operator + ' subject * ' + (first + index)),
    '  return ' + variable, 'end', '',
  ].join('\n');
  const candidate = async (source: string) => {
    const result = await parse(source);
    assert.equal(result.clones?.scheme, 'lua-tokens/v1');
    const declaration = result.clones.candidates.find(item => item.start === 0);
    assert.ok(declaration);
    return declaration;
  };
  const original = await candidate(source('first', 'total', 1));
  const formatted = await candidate(source('first', 'total', 1, '+', true));
  const renamed = await candidate(source('second', 'sum', 19));
  const otherOperator = await candidate(source('first', 'total', 1, '-'));
  assert.deepEqual([original.line, original.endLine, original.codeLines], [1, 22, 22]);
  assert.deepEqual([formatted.endLine, formatted.codeLines], [24, 22]);
  assert.equal(original.exact, formatted.exact);
  assert.equal(original.similar, formatted.similar);
  assert.notEqual(original.exact, renamed.exact);
  assert.equal(original.similar, renamed.similar);
  assert.notEqual(original.similar, otherOperator.similar);
  const { clones } = await parse(source('first', 'total', 1));
  assert.ok(clones?.candidates.some(item => item.line === 2 && item.endLine === 21));
  const table = await parse(['local values = {',
    ...Array.from({ length: 18 }, (_, index) => '  field' + index + ' = "sample",'), '}', ''].join('\n'));
  assert.ok(table.clones?.candidates.some(item => item.start === 'local values = '.length && item.endLine === 20));
  assert.deepEqual((await parse('function short() return 1 end\n')).clones?.candidates, []);
});

test('Lua rejects an incomplete function and keeps Luau outside its selector', async () => {
  await assert.rejects(parse('function broken(value)\n  return value'), { name: 'SyntaxError', message: /line [12], column [0-9]+/ });
  await assert.rejects(parse('local value = 1\n', 'example.luau'), { message: 'No grammar for example.luau' });
});

test('Lua facts reach reports when the official manifest is registered', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-lua-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = ['-- Example', 'local function choose(flag)', '  if flag then return 1 end', '  return 0', 'end', ''].join('\n');
  await Promise.all([
    writeFile(join(directory, 'main.lua'), main),
    writeFile(join(directory, 'other.luau'), 'local value = 1\n'),
    writeFile(join(directory, 'script.js'), 'const sample = 1;\n'),
  ]);
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: [plugin] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 2, parsed: 2 });
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'main.lua')?.provider, 'language-lua/parse');
  assert.equal(report.pluginData?.inventory?.find(file => file.path === 'other.luau')?.provider, undefined);
  const rows = report.measurements.filter(row => row.path === 'main.lua');
  const values = Object.fromEntries(rows.map(row => [row.definition, row.value]));
  assert.equal(values[definitions.lines], 5);
  assert.equal(values[definitions.codeLines], 4);
  assert.equal(values[definitions.comments], 1);
  assert.equal(values[definitions.functions], 1);
  assert.equal(values[definitions.cognitiveComplexity], 1);
  assert.equal(values[definitions.classes], undefined);
  assert.deepEqual(rows.find(row => row.definition === definitions.complexity), {
    definition: definitions.complexity, target: 'function', path: 'main.lua',
    line: 2, column: 1, name: 'choose', value: 2,
  });
});
