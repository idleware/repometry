import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeStructure } from '../../main/ts/core/model/code-structure.js';
import type { CodeStructure } from '../../main/ts/core/model/code-structure.js';
import { qualitySummary } from '../../main/ts/core/model/quality-summary.js';
import { workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { languageRegistry } from '../../main/ts/compose/languages.js';
import { inspectionDetails } from '../../main/ts/report/json/projections/inspection-details.js';
import { inspectionProfileDigest } from '../../main/ts/report/json/projections/inspection-context.js';
import { effectivePlugins } from '../../main/ts/compose/plugin-list.js';
import { inspect } from '../../main/ts/index.js';
import { treeSitter } from './helpers/wasm-plugin.js';
import { analyzeSnapshot } from './helpers/analysis.js';

const go = [
  'package sample', '// Package note.', 'type Widget struct{}', 'func (Widget) score(flag bool) int {',
  '  if flag && true { return 1 }', '  return func() int { return 0 }()', '}', 'func (*Widget) reset() {}', '',
].join('\n');
const python = [
  '# Package note.', 'class Helper:', '    def run(self, flag):', '        def inner(value):',
  '            return 1 if value else 0', '        return inner(flag) if flag else 0', '',
].join('\n');

test('the built-in catalog uses one provider for Go and Python', () => {
  const chosen = effectivePlugins([]).filter(plugin => plugin.providesLanguages?.some(language => ['go', 'python'].includes(language.id)));
  assert.deepEqual(chosen.map(plugin => [plugin.id, plugin.providesLanguages?.map(language => language.id)]),
    [['tree-sitter', ['go', 'python']]]);
});

test('only parsers and grammars used by the inspection appear in the applied profile', async () => {
  const analyze = (entries: readonly (readonly [string, string])[]) => analyzeSnapshot({
    snapshot: workingSnapshot(entries.map(([path, text]) => ({ path, bytes: Buffer.from(text) }))), excludedOutput: null,
  });
  const scripts = await analyze([['main.js', 'const n = 1;']]);
  assert.equal(scripts.appliedConfig.profile, 'repository/v4');
  const onlyGo = await analyze([['unit.go', go], ['bad.py', 'def f(:']]);
  const mixed = await analyze([['unit.go', go], ['unit.py', python]]);
  const parserList = (config: unknown) => (config as readonly { id: string; kinds: readonly string[];
    tools: Record<string, string> }[]).filter(({ kinds }) => kinds.includes('language'));
  assert.deepEqual(parserList(scripts.appliedConfig.plugins).map(({ id }) => id), ['babel-syntax']);
  assert.deepEqual(parserList(onlyGo.appliedConfig.plugins).map(({ id, tools }) => [id, tools]),
    [['tree-sitter', { 'tree-sitter-go': '0.25.0' }]]);
  assert.deepEqual(inspectionDetails(mixed).profile?.analyzers.find(entry => entry.id === 'tree-sitter')?.tools,
    { 'tree-sitter-go': '0.25.0', 'tree-sitter-python': '0.25.0' });
});

test('unused registered grammars preserve the digest while selectors for a present language change it', async () => {
  const base = languageRegistry([]);
  const installed = base.plugins.map(plugin => plugin.id === 'tree-sitter' ? { ...plugin,
    tools: { ...plugin.tools, 'tree-sitter-java': '1.0.0', 'tree-sitter-python': '99.0.0' },
    providesLanguages: [...plugin.providesLanguages!, { id: 'java', label: 'Java', extensions: ['.java'], globs: ['**/java-src'] }],
  } : plugin);
  const registry = { ...base, plugins: installed, extensions: [...base.extensions, '.java'], globs: [...base.globs, '**/java-src'] };
  for (const [path, content, parser, language] of [
    ['unit.js', 'const n = 1;', 'babel-syntax', 'javascript'], ['unit.go', go, 'tree-sitter', 'go'],
  ] as const) {
    const input = { snapshot: workingSnapshot([{ path, bytes: Buffer.from(content) }]), excludedOutput: null };
    const before = await analyzeSnapshot(input, [], undefined, undefined, base);
    const expanded = await analyzeSnapshot(input, [], undefined, undefined, registry);
    assert.notDeepEqual(expanded.appliedConfig.source, before.appliedConfig.source);
    assert.equal(inspectionProfileDigest(expanded), inspectionProfileDigest(before));

    const plugins = installed.map(plugin => plugin.id === parser ? { ...plugin,
      providesLanguages: plugin.providesLanguages?.map(entry => entry.id === language
        ? { ...entry, globs: ['**/sources'] } : entry),
    } : plugin);
    const widened = await analyzeSnapshot(input, [], undefined, undefined,
      { ...registry, plugins, globs: [...registry.globs, '**/sources'] });
    assert.notEqual(inspectionProfileDigest(widened), inspectionProfileDigest(before));
  }
});

test('adding or changing measurements for an unused grammar preserves the inspection digest', async () => {
  const plugin = { ...treeSitter, id: 'fixture-parser' };
  const parsers = { go: [plugin.id], python: [plugin.id] };
  const input = { snapshot: workingSnapshot([{ path: 'file.go', bytes: Buffer.from(go) }]), excludedOutput: null };
  const analyze = (provider: typeof plugin) => analyzeSnapshot(
    input, [provider], undefined, undefined, languageRegistry([provider], parsers));
  const before = await analyze(plugin);
  const declarations = plugin.providesLanguages!;
  const expanded = await analyze({ ...plugin, providesLanguages: [
    ...declarations, { id: 'java', label: 'Java', extensions: ['.java'], measures: ['functions'] },
  ] });
  const changedMeasures = (language: string) => ({ ...plugin, providesLanguages: declarations.map(item =>
    item.id === language ? { ...item, measures: ['functions'] as const } : item) });
  assert.equal(inspectionProfileDigest(expanded), inspectionProfileDigest(before));
  assert.equal(inspectionProfileDigest(await analyze(changedMeasures('python'))), inspectionProfileDigest(before));
  assert.notEqual(inspectionProfileDigest(await analyze(changedMeasures('go'))), inspectionProfileDigest(before));
});

async function parse(path: string, source: string | Buffer): Promise<CodeStructure> {
  const payload = { path, bytes: typeof source === 'string' ? Buffer.from(source) : source };
  const result = await treeSitter.operations[0]!.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return payload as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}

test('changing the extractor fixture output requires a plugin version bump', async () => {
  const fixtures = [await parse('fixture.go', go), await parse('fixture.py', python)];
  const expected: Readonly<Record<string, string>> = {
    '1.0.0': 'b2c7b1e35cb89bf992f47809c647f62106938d3284a3fecfb0bc6db483fad44f',
  };
  assert.equal(hash('sha256', JSON.stringify(fixtures)), expected[treeSitter.version],
    'If the structure output changed intentionally, bump tree-sitter’s version and record the new fixture fingerprint.');
});

test('vendored grammars match their recorded package provenance', async () => {
  const resources = new URL('../resources/languages/', import.meta.resolve('repometry/plugin'));
  for (const id of ['go', 'python']) {
    const grammar = new URL(id + '/tree-sitter.wasm', resources);
    const provenance = JSON.parse(await readFile(new URL(id + '/grammar.json', resources), 'utf8'));
    assert.equal(provenance.package, 'tree-sitter-' + id);
    assert.equal(provenance.version, '0.25.0');
    assert.equal(provenance.license, 'MIT');
    assert.match(provenance.integrity, /^sha512-/);
    assert.equal(hash('sha256', await readFile(grammar)), provenance.sha256);
  }
});

test('Go WASM facts follow the packaged parser’s measures and position conventions', async () => {
  const result = await parse('unit.go', go);
  assert.deepEqual(result.cyclomaticFunctions?.map(({ name, line, column, value }) => [name, line, column, value]),
    [['Widget.score', 4, 1, 3], [undefined, 6, 10, 1], ['(*Widget).reset', 8, 1, 1]]);
  assert.equal(result.cognitiveComplexity, 2);
  assert.equal(result.classes, undefined);
  assert.equal(result.commentLines, 1);
  assert.deepEqual(result.codeLines, [1, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.functionBodies, undefined);
  assert.deepEqual(result.observations?.at(-1),
    { rule: 'file-complexity', value: 2, label: 'File cognitive complexity', line: 1, endLine: 8 });
});

test('Python WASM facts retain class counts and qualified function names', async () => {
  const result = await parse('unit.py', python);
  assert.deepEqual(result.cyclomaticFunctions?.map(({ name, line, column, value }) => [name, line, column, value]),
    [['Helper.run', 3, 5, 2], ['Helper.run.inner', 4, 9, 2]]);
  assert.equal(result.cognitiveComplexity, 2);
  assert.equal(result.classes, 1);
  assert.equal(result.commentLines, 1);
  assert.deepEqual(result.codeLines, [2, 3, 4, 5, 6]);
  assert.equal(result.functionBodies, undefined);
  assert.deepEqual(result.observations?.at(-1), { rule: 'file-complexity', value: 2, label: 'File cognitive complexity' });
});

test('physical line offsets handle Unicode separators and lone carriage returns', async () => {
  const source = 'package main\r\nvar text = `one\u2028two\u2029three\rfour`\nfunc f() {}';
  const result = await parse('unit.go', source);
  assert.equal(result.lines, 6);
  assert.equal(result.cyclomaticFunctions?.[0]?.line, 6);
  assert.deepEqual(result.codeLines, [1, 2, 3, 4, 5, 6]);
});

test('Python decodes an encoding declaration before reading identifiers and comments', async () => {
  const source = Buffer.from('# coding: latin-1\rdef café():\r    return 1\r', 'latin1');
  const result = await parse('legacy.py', source);
  assert.equal(result.lines, 3);
  assert.equal(result.commentLines, 1);
  assert.equal(result.cyclomaticFunctions?.[0]?.name, 'café');
});

test('clone hashes ignore whitespace and comments, and similar hashes also ignore names and values', async () => {
  const body = (name: string, value: number, comment: string) =>
    'package main\nfunc ' + name + '() int {\n' + comment
    + Array.from({ length: 18 }, (_, i) => name + i + ' := ' + value + ' + ' + i + '\n').join('')
    + 'return ' + name + '0\n}\n';
  const candidate = async (name: string, value: number, comment = '') => {
    const result = await parse('unit.go', body(name, value, comment));
    assert.match(result.clones?.scheme ?? '', /^go-tokens\/v1$/);
    const [clone] = result.clones?.candidates ?? [];
    assert.ok(clone);
    return clone;
  };
  const original = await candidate('first', 42);
  const formatted = await candidate('first', 42, '// Formatting-only comment\n\n');
  const renamed = await candidate('second', 61);
  assert.equal(original.exact, formatted.exact);
  assert.equal(original.similar, formatted.similar);
  assert.notEqual(original.exact, renamed.exact);
  assert.equal(original.similar, renamed.similar);
});

test('clone candidates include top-level declarations, statements and whole definitions', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => '  field' + index + ' int');
  const structure = await parse('module.go', ['package a', 'type Record struct {', ...rows, '}', ''].join('\n'));
  assert.ok(structure.clones?.candidates.some(clone => clone.line === 2 && clone.endLine === 27));
  const mappings = Array.from({ length: 20 }, (_, index) => '    ' + index + ': ' + index + ',');
  const module = await parse('module.py', ['values = {', ...mappings, '}', 'class Record:', '    def size(self):',
    ...mappings.map((_, index) => '        value += value * ' + index), '        return value', ''].join('\n'));
  const candidates = module.clones?.candidates;
  assert.ok(candidates?.some(clone => clone.line === 1 && clone.endLine === 22));
  assert.ok(candidates?.some(clone => clone.line === 23 && clone.endLine === 45));
  assert.ok(candidates?.some(clone => clone.line === 24 && clone.endLine === 45));
  assert.ok(candidates?.some(clone => clone.line === 25 && clone.endLine === 45));
});

test('copied function bodies are reported once even when the signatures differ', async () => {
  const repeated = Array.from({ length: 18 }, (_, index) => '    total += n * ' + index).join('\n');
  const moduleGo = (header: string) => 'package sample\n' + header + ' {\n    total := 0\n' + repeated + '\n    return total\n}\n';
  const modulePython = (header: string) => header + ':\n    total = 0\n' + repeated + '\n    return total\n';
  const files = Object.entries({
    'a.go': moduleGo('func First(n int) int'), 'b.go': moduleGo('func Second(n int, extra string) int'),
    'a.py': modulePython('def first(n)'), 'b.py': modulePython('def second(n, extra)'),
  }).map(([path, text]) => ({ path, bytes: Buffer.from(text) }));
  const report = await analyzeSnapshot({ snapshot: workingSnapshot(files), excludedOutput: null });
  const copies = report.findings?.filter(row => row.category === 'duplication') ?? [];
  assert.deepEqual(copies.map(({ rule, path, related }) => [rule, path, related?.map(item => item.path)]).sort(),
    [['identical-code', 'a.go', ['b.go']], ['identical-code', 'a.py', ['b.py']]]);
  const measured = report.measurements.filter(row => row.definition === 'repometry.duplicated-lines/v1');
  assert.deepEqual(measured.map(({ path, value }) => [path, value]),
    [['a.go', 22], ['a.py', 20], ['b.go', 22], ['b.py', 20]]);
});

const anchorSamples = [
  { path: 'slot.go',
    source: 'package sample\ntype Slot struct{}\nfunc (s *Slot) CompareAndSwap(a, b bool) bool {\n  if a && b { return true }\n  return func() bool { return a }()\n}\n',
    anchors: ['(*Slot).CompareAndSwap.(anonymous)', '(*Slot).CompareAndSwap'], logic: '(*Slot).CompareAndSwap' },
  { path: 'serializer.py',
    source: 'class Serializer:\n    def loads(self, a, b):\n        if a and b:\n            return 1\n        return (lambda: 0)()\n',
    anchors: ['Serializer.loads.(anonymous)', 'Serializer.loads'], logic: 'Serializer.loads' },
] as const;

for (const sample of anchorSamples) {
  test(`the WASM parser anchors ${sample.path} observations to qualified names`, async () => {
    const { observations: observed = [] } = await parse(sample.path, sample.source);
    assert.deepEqual(observed.filter(row => row.rule === 'function-complexity').map(row => row.anchor), sample.anchors);
    assert.equal(observed.find(row => row.rule === 'boolean-logic')?.anchor, sample.logic);
    assert.equal(observed.find(row => row.rule === 'file-complexity')?.anchor, undefined);
  });
}

test('reports similar code while retaining full grades across Go and Python', async () => {
  const make = (name: string, start: number) => {
    const lines = Array.from({ length: 12 }, (_, value) => '    total += n * ' + (start + value));
    return [
      { path: name + '.go', bytes: Buffer.from(['package sample', 'func ' + name + '(n int) int {',
        '    total := 0', ...lines, '    return total', '}', ''].join('\n')) },
      { path: name + '.py', bytes: Buffer.from(['def ' + name + '(n):',
        '    total = 0', ...lines, '    return total', ''].join('\n')) },
    ];
  };
  const snapshot = workingSnapshot([...make('first', 2), ...make('second', 18)]);
  const report = await analyzeSnapshot({ snapshot, excludedOutput: null });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.scope, { files: 4, parsed: 4 });
  assert.equal(report.ruleSkips, undefined);
  assert.equal(report.findings?.filter(row => row.rule === 'similar-code').length, 2);
  const maintainability = qualitySummary(report).maintainability;
  assert.ok(maintainability?.grade);
  assert.equal(maintainability.gradeCoverage, undefined);
});

test('parse diagnostics identify the first syntax issue in source coordinates', async () => {
  await assert.rejects(parse('bare-else.py', 'else:\n'), { message: 'Unexpected syntax at line 1, column 1' });
  await assert.rejects(parse('missing-if-colon.py', 'if x\n    pass\n'), { message: 'Expected ":" at line 1, column 5' });
  await assert.rejects(parse('unfinished.py', 'text = "broken\n'), { message: 'Unterminated string at line 1, column 8' });
  await assert.rejects(parse('stray.go', 'package p\nfunc f() {\n x := 1+ )\n}\n'),
    { message: 'Unexpected syntax at line 3, column 10' });
  await assert.rejects(parse('missing-colon.py', 'def c()\n    pass\n'),
    { message: 'Expected ":" or "->" at line 1, column 8' });
  await assert.rejects(parse('invalid.go', 'package sample\r\nfunc f( {}'),
    { message: 'Expected ")" at line 2, column 8' });
  await assert.rejects(parse('unicode.py', 'if café pass: pass\n'),
    { message: 'Unexpected syntax at line 1, column 9' });
  await assert.rejects(parse('missing.py', 'def f():\n    return len([1, 2)\n'),
    { message: 'Expected "]" at line 2, column 21' });
  await assert.rejects(parse('invalid.go', '// note\nvar n = 0'),
    { message: 'Expected a package clause at line 2, column 1' });
  await assert.rejects(parse('empty.py', 'if flag:\n    # No statement\n'),
    { message: 'Expected a statement in the block at line 1, column 9' });
});

test('Go parses a grouped declaration at EOF without changing its physical line count', async () => {
  const result = await parse('unit.go', 'package p\n\nconst (\n\tA = "a"\n)');
  assert.equal(result.lines, 5);
  assert.equal(result.observations?.at(-1)?.endLine, 5);
});

test('walks deep nested statements, chained alternatives and boolean expressions', async () => {
  const deep = 2000;
  const nesting = 'package p\nfunc deep(){\n' + 'if x {\n'.repeat(deep) + '}\n'.repeat(deep) + '}\n';
  const nested = await parse('nested.go', nesting);
  assert.equal(nested.cyclomaticFunctions?.[0]?.value, deep + 1);
  const alternatives = 'package p\nfunc deep(){\nif x {}' + ' else if x {}'.repeat(3000) + '\n}\n';
  const chained = await parse('alternatives.go', alternatives);
  assert.equal(chained.cognitiveFunctions?.[0]?.value, 3001);
  const py = 'def f(a):\n  return ' + Array(20_001).fill('a').join(' and ') + '\n';
  const chain = await parse('chain.py', py);
  assert.equal(chain.cyclomaticFunctions?.[0]?.value, 20_001);
  assert.equal(chain.cognitiveFunctions?.[0]?.value, 1);
});

test('walks a literal with more children than the JavaScript argument limit', async () => {
  const source = 'package p\nconst data = "' + String.raw`\x00`.repeat(130_000) + '"\n';
  const result = await parse('wide.go', source);
  assert.equal(result.lines, 2);
  assert.equal(result.functions, 0);
});

test('Python counts its physical lines and distinguishes grouped patterns from sequences', async () => {
  const grouped = await parse('grouped.py', 'text = "a\u2028b"\ndef f(v):\n  match v:\n    case ((x)): pass\n');
  assert.equal(grouped.cyclomaticFunctions?.[0]?.line, 2);
  assert.equal(grouped.cyclomaticFunctions?.[0]?.value, 1);
  for (const pattern of ['(x,)', '[x]', 'x, y', '((x),)']) {
    const tuple = await parse('sequence.py', 'def f(v):\n  match v:\n    case ' + pattern + ': pass\n');
    assert.equal(tuple.cyclomaticFunctions?.[0]?.value, 2, pattern);
  }
});

test('Python accepts source codec aliases and distinguishes imaginary from real tokens', async () => {
  for (const [label, encoding] of [['latin-1-unix', 'latin1'], ['iso-latin-1', 'latin1'], ['utf-8-mac', 'utf8'],
    ['mac-roman', 'ascii'], ['big5hkscs', 'ascii']] as const) {
    const structure = await parse('legacy.py', Buffer.from('# coding: ' + label + '\ndef f(): pass\n', encoding));
    assert.equal(structure.functions, 1);
  }
  const values = (suffix: string) => ['values = [', ...Array.from({ length: 30 }, (_, index) => '  ' + index + suffix + ','), ']'].join('\n');
  const imaginary = await parse('imaginary.py', values('j'));
  const real = await parse('integer.py', values(''));
  assert.ok(imaginary.clones?.candidates[0]);
  assert.ok(real.clones?.candidates[0]);
  assert.notEqual(imaginary.clones.candidates[0].similar, real.clones.candidates[0].similar);
});

test('Python visits defaults before decorators and locates a filter at its expression', async () => {
  const source = [
    '@decorate(lambda: 1)', 'def f(arg=lambda: 2):',
    '    return [item for item in values if (', '        item is not None', '    )]', '',
  ].join('\n');
  const result = await parse('order.py', source);
  assert.deepEqual(result.observations?.filter(row => row.rule === 'function-complexity').slice(0, 2).map(row => row.line), [2, 1]);
  assert.equal(result.observations?.find(row => row.rule === 'nested-control-flow')?.line, 4);
});

test('Python observations skip continuations inside expressions and trim trailing comments', async () => {
  const source = ['def choose(a, b, c):', '    if (a ' + String.fromCharCode(92), '            or b and c):',
    '        return 1', '    # End of the function', ''].join('\n');
  const result = await parse('unit.py', source);
  assert.equal(result.cognitiveComplexity, 3);
  assert.equal(result.observations?.find(row => row.rule === 'boolean-logic')?.value, 2);
  assert.equal(result.observations?.find(row => row.rule === 'function-complexity')?.endLine, 4);
});

test('a definition retains its header and each statement token range is unique', async () => {
  const body = Array.from({ length: 18 }, (_, i) => '        n += n * ' + i);
  const source = ['def sequence(n):', '    if n:', ...body, '        return n'].join('\n');
  const result = await parse('unit.py', source);
  const spans = result.clones?.candidates.map(({ start, end }) => start + ':' + end) ?? [];
  assert.ok(spans.length > 0);
  assert.ok(result.clones?.candidates.some(clone => clone.line === 1));
  assert.equal(spans.length, new Set(spans).size);
});

test('mixed inspection works without native tools and rejects broken syntax per file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-wasm-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([writeFile(join(directory, 'unit.go'), go), writeFile(join(directory, 'unit.py'), python)]);
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const options = { directory, output: join(directory, '.repometry', 'data'),
      source: { workingTree: true } as const };
    const report = await inspect(options);
    assert.equal(report.status, 'complete');
    assert.equal(qualitySummary(report).maintainability?.grade, 'A');
    assert.deepEqual(report.scope, { files: 2, parsed: 2 });
    assert.deepEqual(report.pluginData?.inventory?.map(file => file.provider), ['tree-sitter/parse', 'tree-sitter/parse']);
    const snapshot = workingSnapshot([
      { path: 'valid.go', bytes: Buffer.from(go) },
      { path: 'invalid.go', bytes: Buffer.from('package sample\nfunc f( {}') },
      { path: 'invalid.py', bytes: Buffer.from('def f():\n    return (') },
      { path: 'empty.py', bytes: Buffer.from('if flag:\n    # No statement\n') },
    ]);
    const partial = await analyzeSnapshot({ snapshot, excludedOutput: null });
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.scope, { files: 4, parsed: 1 });
    for (const path of ['invalid.go', 'invalid.py', 'empty.py']) {
      assert.equal(partial.diagnostics.filter(diagnostic => diagnostic.path === path && diagnostic.operation === 'tree-sitter/parse').length, 1);
      assert.equal(partial.pluginData?.inventory?.find(file => file.path === path)?.analysed, false);
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
