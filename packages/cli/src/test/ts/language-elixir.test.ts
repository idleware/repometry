import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, StructuralObservation } from '@repometry/core';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import manifest, { elixir } from '@repometry/language-elixir';

async function parse(source: string, path = 'fixture.ex'): Promise<CodeStructure> {
  const result = await manifest.create().operations[0]!.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path, bytes: Buffer.from(source) } as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

function functionRows(rows: CodeStructure['cyclomaticFunctions']) {
  return rows?.map(({ name, line, column, value }) => [name, line, column, value]);
}

function observations(result: CodeStructure, check: StructuralObservation['check']) {
  return (result.observations ?? []).filter(row => row.check === check).map(({ anchor, line, endLine, value }) =>
    [anchor, line, endLine, value]);
}

test('the Elixir package keeps its official WASM, license and notice', async () => {
  assert.equal(manifest.id, 'language-elixir');
  assert.deepEqual(manifest.tools, { 'tree-sitter-elixir': '0.3.5' });
  assert.deepEqual(elixir.language.extensions, ['.ex', '.exs']);
  assert.equal(createHash('sha256').update(await readFile(elixir.asset)).digest('hex'),
    '1818ae0d7343f880abb0b7932c9a815f09896ca67b3e126096a2dd7677d1477b');
  assert.match(await readFile(new URL('tree-sitter.LICENSE', elixir.asset), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.match(await readFile(new URL('tree-sitter.NOTICE', elixir.asset), 'utf8'), /The MIT License/);
});

test('Elixir scopes modules and body-bearing declarations and separates anonymous functions', async () => {
  const source = String.raw`# Top comment.
defmodule Outer do
  defmodule Worker do
    def run(x \\ 0)
    def run(x) when x > 0 and x < 10 do
      # Body comment.
      chooser = fn y, z when is_integer(y) -> {y, z}; y, z -> {y, z} end
      chooser.(x, x) # Inline comment.
    end
    defp private, do: :ok
    defmacro public(value), do: quote(do: unquote(value))
    defmacrop hidden(value), do: value
  end
end
defprotocol Sized do
  def size(value)
end
defimpl Sized, for: Outer.Worker do
  def size(_), do: 1
end
`;
  const result = await parse(source, 'scope.exs');
  assert.equal(result.lines, 20);
  assert.equal(result.commentLines, 2);
  assert.deepEqual(result.codeLines, [2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(result.classes, 4);
  assert.equal(result.functions, 6);
  assert.equal(result.cognitiveComplexity, 1);
  assert.deepEqual(functionRows(result.cyclomaticFunctions), [
    ['Outer.Worker.run', 5, 5, 3], [undefined, 7, 17, 2], ['Outer.Worker.private', 10, 5, 1],
    ['Outer.Worker.public', 11, 5, 1], ['Outer.Worker.hidden', 12, 5, 1], ['Sized.Outer.Worker.size', 19, 3, 1],
  ]);
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['Outer.Worker.run.(anonymous)', 7, 7, 2], ['Outer.Worker.run', 5, 9, 1], ['Outer.Worker.private', 10, 10, 0],
    ['Outer.Worker.public', 11, 11, 1], ['Outer.Worker.hidden', 12, 12, 1], ['Sized.Outer.Worker.size', 19, 19, 1],
  ]);
  assert.deepEqual(observations(result, 'return-statements').map(row => row[3]), [0, 0, 0, 0, 0, 0]);
});

test('Elixir if and unless count ordinary and alternate branches at equivalent depths', async () => {
  const result = await parse(`defmodule Demo do
  def choose(a, b, c) do
    if a && (b || c) && a do
      unless b, do: 1, else: 2
    else
      if c do
        3
      else
        4
      end
    end
  end
end
`);
  assert.deepEqual(functionRows(result.cyclomaticFunctions), [['Demo.choose', 2, 3, 7]]);
  assert.deepEqual(functionRows(result.cognitiveFunctions), [['Demo.choose', 2, 3, 11]]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['Demo.choose', 4, 4, 2]]);
  assert.deepEqual(observations(result, 'boolean-logic'), [['Demo.choose', 3, 3, 3]]);
});

test('Elixir counts inline captures and uses code-point columns with CRLF source', async () => {
  const result = await parse('value = "🧪"; fn -> value end\r\ncapture = &(&1 + &2)\r\nreference = &String.length/1\r\n');
  assert.equal(result.lines, 3);
  assert.deepEqual(functionRows(result.cyclomaticFunctions), [[undefined, 1, 14, 1], [undefined, 2, 11, 1]]);
  assert.deepEqual(observations(result, 'function-parameters'), [
    ['(anonymous)', 1, 1, 0], ['(anonymous)', 2, 2, 2],
  ]);
});

test('Elixir counts comprehension generators, match arms, guards, and exception handlers', async () => {
  const result = await parse(`defmodule Worker do
  def run(input) do
    for x <- input, x > 0, y <- [x], do: y
    with {:ok, a} <- fetch(input), {:ok, b} <- fetch(a), do: b
    case input do
      {:ok, x} when x > 0 -> x
      _ -> 0
    end
    cond do
      input != [] -> :yes
      true -> :no
    end
    receive do
      {:data, value} -> value
      ignored -> ignored
    after 10 -> :timeout
    end
    try do
      do_work()
    rescue
      ArgumentError -> :error
    catch
      :throw, value -> value
    else
      {:ok, value} -> value
    after
      cleanup()
    end
  end
end
`);
  assert.deepEqual(functionRows(result.cyclomaticFunctions), [['Worker.run', 2, 3, 14]]);
  assert.deepEqual(functionRows(result.cognitiveFunctions), [['Worker.run', 2, 3, 7]]);
  assert.deepEqual(observations(result, 'nested-control-flow'), [['Worker.run', 3, 3, 1]]);
});

test('Elixir counts case arms in keyword and do-block forms', async () => {
  const result = await parse(`defmodule Worker do
  def inline(value), do: case(value, do: ({:ok, x} -> x; _ -> 0))
  def block(value) do
    case value do
      {:ok, x} -> x
      _ -> 0
    end
  end
end
`);
  assert.deepEqual(functionRows(result.cyclomaticFunctions), [['Worker.inline', 2, 3, 2], ['Worker.block', 3, 3, 2]]);
  assert.deepEqual(functionRows(result.cognitiveFunctions), [['Worker.inline', 2, 3, 1], ['Worker.block', 3, 3, 1]]);
});

test('Elixir clone fingerprints preserve declared code spans and normalize names and literals', async () => {
  const source = (name: string, offset: number, comment = '') => ['defmodule Repeated do', `  def ${name}(input) do`,
    '    first = input + 10', comment,
    ...Array.from({ length: 14 }, (_, index) => `    a${index} = input + ${offset + index}`),
    '    first + a13', '  end', 'end', ''].join('\n');
  const plain = await parse(source('left', 20));
  const commented = await parse(source('left', 20, '    # Formatting only.'));
  const renamed = await parse(source('right', 40));
  const candidates = (result: CodeStructure) => result.clones?.candidates.filter(row => row.line === 2 || row.line === 3) ?? [];
  assert.equal(plain.clones?.scheme, 'elixir-tokens/v1');
  assert.deepEqual(candidates(plain).map(({ line, endLine, codeLines, nodes }) => [line, endLine, codeLines, nodes]),
    [[2, 20, 18, 85], [2, 20, 18, 80]]);
  assert.deepEqual(candidates(plain).map(row => row.exact), candidates(commented).map(row => row.exact));
  assert.deepEqual(candidates(plain).map(row => row.similar), candidates(renamed).map(row => row.similar));
  assert.notDeepEqual(candidates(plain).map(row => row.exact), candidates(renamed).map(row => row.exact));
});

test('Elixir reports copied bodies and exact function positions across .ex and .exs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-elixir-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = [
    '    width = input.width',
    '    height = input.height',
    '    padding = input.padding',
    '    padded_width = width + padding',
    '    padded_height = height + padding',
    '    area = padded_width * padded_height',
    '    perimeter = 2 * (padded_width + padded_height)',
    '    origin = {input.x, input.y}',
    '    size = {padded_width, padded_height}',
    '    dimensions = %{area: area, perimeter: perimeter}',
    '    details = %{origin: origin, size: size}',
    '    if area > 100, do: {:large, dimensions, details}, else: {:small, dimensions, details}',
  ].join('\n');
  await Promise.all([
    writeFile(join(directory, 'box.ex'), `defmodule Box do\n  def measure(input) do\n${body}\n  end\nend\n`),
    writeFile(join(directory, 'panel.exs'),
      `# Adjusted signature.\ndefmodule Panel do\n  @doc "🧪"; def classify(input, _options) do\n${body}\n  end\nend\n`),
  ]);
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: [manifest] });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 2, parsed: 2 });
  assert.deepEqual(report.measurements.filter(row => row.definition === definitions.complexity), [
    { definition: definitions.complexity, target: 'function', path: 'box.ex', line: 2, column: 3, name: 'Box.measure', value: 2 },
    { definition: definitions.complexity, target: 'function', path: 'panel.exs', line: 3, column: 13, name: 'Panel.classify', value: 2 },
  ]);
  const copies = report.findings?.filter(row => row.category === 'duplication') ?? [];
  assert.deepEqual(copies.map(({ rule, path, line, endLine, related }) => ({ rule, path, line, endLine, related })), [
    { rule: 'identical-code', path: 'box.ex', line: 2, endLine: 15, related: [{ path: 'panel.exs', line: 3, endLine: 16 }] },
  ]);
  assert.deepEqual(report.measurements.filter(row => row.definition === definitions.duplicatedLines).map(({ path, value }) => [path, value]),
    [['box.ex', 14], ['panel.exs', 14]]);
});

test('Elixir rejects a malformed file even when it has a valid earlier function', async () => {
  await assert.rejects(parse('defmodule Good do\n  def valid, do: :ok\nend\n\ndefmodule Broken do\n  def broken(\n'), {
    name: 'SyntaxError',
    message: 'Unexpected syntax at line 6, column 14',
  });
});
