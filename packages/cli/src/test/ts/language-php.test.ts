import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeStructure } from '@repometry/core';
import manifest, { php } from '@repometry/language-php';

async function parse(source: string) {
  const payload = { path: 'fixture.php', bytes: Buffer.from(source) };
  const result = await manifest.create().operations[0]!.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return payload as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

test('PHP measures class-like declarations, functions and closures in a mixed template', async () => {
  const source = `<section>
<?php
// First comment.
/*
 * Second comment.
 */
interface Contract { public function run(int $n): int; }
trait Defaults { public function reset(): void {} }
enum Mode { case Ready; }
class Worker implements Contract {
    public function run(int $n = 0, ...$flags): int {
        // A comment inside the method body.
        function increment($n) { return $n + 1; }
        $f = function ($x) use ($n) { return $x + $n; };
        $g = fn ($x) => $x ? 1 : 0;
        return $g($f(increment($n))); // Code with a comment.
    }
}
function café($a) { return $a; } $a = /* π */ fn ($a) => $a;
$worker = new class { public function render() {} };
?>
</section>
`;
  const result = await parse(source);
  assert.equal(php.language.syntax, undefined);
  assert.equal(result.lines, 22);
  assert.equal(result.classes, 5);
  assert.equal(result.functions, 8);
  assert.equal(result.commentLines, 5);
  assert.deepEqual(result.codeLines, [1, 2, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  assert.equal(result.cognitiveComplexity, 1);
  assert.deepEqual(result.cyclomaticFunctions?.map(({ name, line, column, value }) => [name, line, column, value]), [
    ['Defaults.reset', 8, 18, 1], ['Worker.run', 11, 5, 1],
    ['Worker.run.increment', 13, 9, 1], [undefined, 14, 14, 1], [undefined, 15, 14, 2],
    ['café', 19, 1, 1], [undefined, 19, 49, 1], ['render', 20, 23, 1],
  ]);
  assert.deepEqual(result.cognitiveFunctions?.filter(row => row.value > 0), [{ line: 15, column: 14, value: 1 }]);
  const facts = (rule: string) => result.observations?.filter(row => row.check === rule)
    .map(({ anchor, line, endLine, value }) => [anchor, line, endLine, value]);
  assert.deepEqual(facts('function-parameters'), [
    ['Defaults.reset', 8, 8, 0], ['Worker.run.increment', 13, 13, 1],
    ['Worker.run.(anonymous)', 14, 14, 1], ['Worker.run.(anonymous)', 15, 15, 1], ['Worker.run', 11, 17, 2],
    ['café', 19, 19, 1], ['(anonymous)', 19, 19, 1], ['render', 20, 20, 0],
  ]);
  assert.deepEqual(facts('return-statements'), [
    ['Defaults.reset', 8, 8, 0], ['Worker.run.increment', 13, 13, 1],
    ['Worker.run.(anonymous)', 14, 14, 1], ['Worker.run.(anonymous)', 15, 15, 0], ['Worker.run', 11, 17, 1],
    ['café', 19, 19, 1], ['(anonymous)', 19, 19, 0], ['render', 20, 20, 0],
  ]);
});

test('PHP measures concrete methods and skips signatures in classes, interfaces and traits', async () => {
  const result = await parse(`<?php
interface Reader { public function read(int $count): string; }
abstract class Source {
    abstract protected function reset(bool $force): void;
    public function close(): void {}
}
trait Buffered { abstract protected function flush(): void; }
`);
  assert.equal(result.classes, 3);
  assert.equal(result.functions, 1);
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'Source.close', line: 5, column: 5, value: 1 }]);
  const parameters = result.observations?.filter(item => item.check === 'function-parameters');
  assert.deepEqual(parameters?.map(({ anchor, value }) => [anchor, value]), [['Source.close', 0]]);
});

test('PHP counts loop decisions, sibling elseif branches and runs of boolean operators', async () => {
  const result = await parse(`<?php
function flow($a, $b, $c, $d, $items) {
    if ($a && ($b || $c) && $d) {
        for (;;) {
            if ($a) { break; }
        }
    } elseif ($c OR ($a and $b)) {
        foreach ($items as $item) { continue; }
    } else {
        while ($c) { do { break 2; } while ($d); }
    }
}
`);
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'flow', line: 2, column: 1, value: 13 }]);
  assert.deepEqual(result.cognitiveFunctions, [{ name: 'flow', line: 2, column: 1, value: 21 }]);
  assert.deepEqual(result.observations?.filter(row => row.check === 'boolean-logic').map(({ anchor, line, value }) =>
    [anchor, line, value]), [['flow', 3, 3], ['flow', 7, 2]]);
  assert.deepEqual(result.observations?.find(row => row.check === 'nested-control-flow'), {
    check: 'nested-control-flow', anchor: 'flow', line: 5, endLine: 5, label: 'flow · Control-flow depth', value: 3,
  });
});

test('PHP counts elseif and else if equally and keeps an if inside an else block nested', async () => {
  const source = (alternative: string) => `<?php
function branch($first, $second) {
    if ($first) {
        return 1;
    } ${alternative}
}
`;
  const outcomes = [
    ['elseif ($second) { return 2; } else { return 3; }', 3, 1, 3],
    ['else if ($second) { return 2; } else { return 3; }', 3, 1, 3],
    ['else {\n        if ($second) { return 2; } else { return 3; }\n    }', 5, 2, 6],
  ] as const;
  for (const [alternative, cognitive, depth, deepestLine] of outcomes) {
    const result = await parse(source(alternative));
    assert.deepEqual(result.cyclomaticFunctions, [{ name: 'branch', line: 2, column: 1, value: 3 }], alternative);
    assert.deepEqual(result.cognitiveFunctions, [{ name: 'branch', line: 2, column: 1, value: cognitive }], alternative);
    const deepest = result.observations?.find(row => row.check === 'nested-control-flow');
    assert.deepEqual([deepest?.value, deepest?.line], [depth, deepestLine], alternative);
  }
});

test('PHP counts nondefault switch and match arms, ternaries, catch and null-aware expressions', async () => {
  const result = await parse(`<?php
function dispatch($value) {
    switch ($value) {
        case 1:
        case 2:
            return 1;
        default:
            goto done;
    }
    done:
    try {
        return match ($value) {
            1, 2 => 10,
            3 => $value ? 11 : 12,
            default => $value ?: 0,
        };
    } catch (LogicException|RuntimeException $error) {
        return 20;
    } finally {
        $result ??= $value?->method() ?? $value?->property;
    }
}
`);
  assert.deepEqual(result.cyclomaticFunctions, [{ name: 'dispatch', line: 2, column: 1, value: 12 }]);
  assert.deepEqual(result.cognitiveFunctions, [{ name: 'dispatch', line: 2, column: 1, value: 8 }]);
  assert.deepEqual(result.observations?.find(row => row.check === 'nested-control-flow'), {
    check: 'nested-control-flow', anchor: 'dispatch', line: 14, endLine: 14, label: 'dispatch · Control-flow depth', value: 2,
  });
  assert.equal(result.observations?.find(row => row.check === 'return-statements')?.value, 3);
});

test('PHP accepts colon-delimited control flow across embedded markup', async () => {
  const result = await parse(`<?php if ($ready): ?>
    <p>Ready</p>
<?php elseif ($loading): ?>
    <?= "Loading" ?>
<?php else: ?>
    <?php # Waiting. ?>
    <p>Waiting</p>
<?php endif ?>
`);
  assert.equal(result.functions, 0);
  assert.equal(result.cognitiveComplexity, 3);
  assert.equal(result.commentLines, 0);
  assert.deepEqual(result.codeLines, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.observations?.find(row => row.check === 'nested-control-flow')?.value, 1);
});

test('PHP clone candidates retain definitions and body blocks while ignoring layout', async () => {
  const source = (name: string, start: number, markup = '') =>
    ['<?php', `function ${name}($input)`, '{', '    $total = 0;', markup,
      ...Array.from({ length: 15 }, (_, index) => `    $total += $input * ${start + index};`), '    return $total;', '}', ''].join('\n');
  const original = (await parse(source('first', 10))).clones;
  const formatted = (await parse(source('first', 10, '// Layout only.\n?>\n<p>Markup between statements.</p>\n<?php'))).clones;
  const renamed = (await parse(source('second', 20))).clones;
  assert.equal(original?.scheme, 'php-tokens/v1');
  assert.deepEqual(original?.candidates.map(({ line, endLine, codeLines, nodes }) => [line, endLine, codeLines, nodes]),
    [[2, 22, 20, 104], [3, 22, 19, 99]]);
  assert.deepEqual(original?.candidates.map(row => row.exact), formatted?.candidates.map(row => row.exact));
  assert.deepEqual(original?.candidates.map(row => row.similar), renamed?.candidates.map(row => row.similar));
  assert.notDeepEqual(original?.candidates.map(row => row.exact), renamed?.candidates.map(row => row.exact));
});
