import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import plugin from '@repometry/language-ruby';

async function parse(source: string): Promise<CodeStructure> {
  const [operation] = plugin.create().operations;
  assert.ok(operation);
  const result = await operation.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path: 'example.rb', bytes: Buffer.from(source) } as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

function observations(structure: CodeStructure, check: StructuralObservation['check']) {
  return structure.observations?.filter(item => item.check === check).map(({ anchor, line, endLine, value }) =>
    [anchor, line, endLine, value]);
}

test('Ruby locates methods and lambdas under modules, classes and singleton classes', async () => {
  const result = await parse([
    'module Studio', '  module Rules', '    class Gate',
    '      def run((left, right), default = 1, *items, required:, quiet: true, **named, &block)',
    '        items.each do |item|', '          return item if item', '        end',
    '        items.map { |item| item.to_s }',
    '        badge = "🎛"; ->(item, *args) { return item unless item }', '      end',
    '      def self.build(...)', '        new(...)', '      end',
    '      class << self', '        def create = new', '      end',
    '    end', '    def reset; end', '  end', 'end',
  ].join('\r\n'));
  assert.equal(result.classes, 2);
  assert.equal(result.functions, 5);
  assert.deepEqual(result.cyclomaticFunctions, [
    { name: 'Studio.Rules.Gate.run', line: 4, column: 7, value: 2 },
    { line: 9, column: 22, value: 2 },
    { name: 'Studio.Rules.Gate.build', line: 11, column: 7, value: 1 },
    { name: 'Studio.Rules.Gate.create', line: 15, column: 9, value: 1 },
    { name: 'Studio.Rules.reset', line: 18, column: 5, value: 1 },
  ]);
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['Studio.Rules.Gate.run.(anonymous)', 9, 9, 2],
    ['Studio.Rules.Gate.run', 4, 10, 7],
    ['Studio.Rules.Gate.build', 11, 13, 1],
    ['Studio.Rules.Gate.create', 15, 15, 0],
    ['Studio.Rules.reset', 18, 18, 0],
  ]);
  assert.deepEqual(observations(result, 'return-statements'), [
    ['Studio.Rules.Gate.run.(anonymous)', 9, 9, 1],
    ['Studio.Rules.Gate.run', 4, 10, 1],
    ['Studio.Rules.Gate.build', 11, 13, 0],
    ['Studio.Rules.Gate.create', 15, 15, 0],
    ['Studio.Rules.reset', 18, 18, 0],
  ]);
});

const flowCases = [
  ['if and elsif', ['if first', '  use_first', 'elsif second', '  use_second',
    'elsif third', '  use_third', 'else', '  fallback', 'end'], 4, 4, 1],
  ['a loop in the final alternative', ['if first', '  use_first', 'elsif second', '  use_second',
    'else', '  while ready', '    work', '  end', 'end'], 4, 5, 2],
  ['unless', ['unless ready', '  wait', 'else', '  work', 'end'], 2, 2, 1],
  ['nested for, while and until', ['for job in jobs', '  while ready', '    until done', '      job.run',
    '    end', '  end', 'end'], 4, 6, 3],
  ['case and when', ['case kind', 'when :hot, :warm', '  heat', 'when :cold', '  chill', 'else', '  rest', 'end'], 3, 1, 1],
  ['case matching and guards', ['case value', 'in [first] if ready', '  use(first)',
    'in {last:} unless paused', '  use(last)', 'else', '  stop', 'end'], 5, 1, 1],
  ['a loop in a case fallback', ['case kind', 'when :hot', '  heat', 'else', '  while ready', '    work',
    '  end', 'end'], 3, 3, 2],
  ['a branch in a pattern matching fallback', ['case value', 'in [first]', '  use(first)', 'else',
    '  if ready', '    work', '  end', 'end'], 3, 3, 2],
  ['rescue clauses', ['begin', '  work', 'rescue IOError', '  retry_job', 'rescue TypeError, ArgumentError',
    '  fail_job', 'else', '  finish', 'ensure', '  close', 'end'], 3, 3, 1],
  ['ternary', ['ready ? here : there'], 2, 1, 1],
  ['if modifier', ['work if ready'], 2, 1, 1],
  ['unless modifier', ['wait unless ready'], 2, 1, 1],
  ['while modifier', ['work while ready'], 2, 1, 1],
  ['until modifier', ['wait until ready'], 2, 1, 1],
  ['rescue modifier', ['work rescue retry_job'], 2, 1, 1],
] as const;

for (const [construct, body, cyclomatic, cognitive, depth] of flowCases) {
  test('Ruby measures ' + construct, async () => {
    const result = await parse(['def work_job', ...body.map(line => '  ' + line), 'end'].join('\n'));
    const position = { name: 'work_job', line: 1, column: 1 };
    assert.deepEqual(result.cyclomaticFunctions, [{ ...position, value: cyclomatic }]);
    assert.deepEqual(result.cognitiveFunctions, [{ ...position, value: cognitive }]);
    assert.equal(result.cognitiveComplexity, cognitive);
    assert.deepEqual(result.observations?.filter(item => item.check === 'nested-control-flow')
      .map(({ anchor, value }) => [anchor, value]), [['work_job', depth]]);
  });
}

test('Ruby gives a four-arm case the same scores with or without a default', async () => {
  const arms = ['def classify(kind)', '  case kind', '  when :first then 1', '  when :second then 2',
    '  when :third then 3', '  when :fourth then 4'];
  for (const fallback of [[], ['  else 0']]) {
    const result = await parse([...arms, ...fallback, '  end', 'end', ''].join('\n'));
    assert.equal(result.cyclomaticFunctions?.[0]?.value, 5);
    assert.equal(result.cognitiveFunctions?.[0]?.value, 1);
    assert.equal(result.cognitiveComplexity, 1);
  }
});

test('Ruby locates grouped boolean expressions and the deepest nested control flow', async () => {
  const result = await parse([
    'def route(a, b, c, d)', '  if (a && b) && c || d', '    while a and (b or c)',
    '      return d', '    end', '  end', 'end', 'fallback if delayed', '',
  ].join('\n'));
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'route', line: 1, column: 1, value: 8 }]);
  assert.deepEqual(result.cognitiveFunctions, [{ name: 'route', line: 1, column: 1, value: 7 }]);
  assert.equal(result.cognitiveComplexity, 8);
  assert.deepEqual(observations(result, 'boolean-logic'), [['route', 2, 2, 3], ['route', 3, 3, 2]]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['route', 3, 5, 2], [undefined, 8, 8, 1]]);
  assert.deepEqual(observations(result, 'file-complexity'), [[undefined, undefined, undefined, 8]]);
});

test('Ruby counts multiline comments and inline code, including heredoc contents', async () => {
  const result = await parse([
    '#!/usr/bin/env ruby', '# frozen_string_literal: true', '=begin', '', 'Documentation.', '=end', '',
    'def load_text', '  text = <<~RAW # Inline comment', "    it's # text", '  RAW', '  # A comment',
    '  text # More inline code', 'end', '',
  ].join('\n'));
  assert.equal(result.lines, 14);
  assert.equal(result.commentLines, 7);
  assert.deepEqual(result.codeLines, [8, 9, 10, 11, 13, 14]);
  assert.equal(result.functions, 1);
});

test('Ruby clone fingerprints preserve operators and abstract changed names and literals', async () => {
  const source = (name: string, variable: string, first: number, symbol = '+', comment = '') => [
    'def ' + name + '(input)', ...(comment ? [comment, ''] : []),
    '  ' + variable + ' = 0',
    ...Array.from({ length: 12 }, (_, index) => '  ' + variable + ' += input ' + symbol + ' ' + (first + index)),
    '  return ' + variable, 'end', '',
  ].join('\n');
  const fingerprints = async (text: string) => {
    const result = await parse(text);
    assert.equal(result.clones?.scheme, 'ruby-tokens/v1');
    const definition = result.clones.candidates.find(item => item.line === 1);
    assert.ok(definition);
    return definition;
  };
  const original = await fingerprints(source('first', 'total', 1));
  const formatted = await fingerprints(source('first', 'total', 1, '+', '  # A note'));
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
  assert.ok(result.clones?.candidates.some(item => item.line === 2 && item.endLine === 15));
  assert.deepEqual((await parse('def short; 1; end\n')).clones?.candidates, []);
});

test('Ruby rejects malformed methods with a source location', async () => {
  await assert.rejects(parse('def broken(\n'), { name: 'SyntaxError', message: /line 1, column [0-9]+/ });
});
