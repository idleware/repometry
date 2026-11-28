import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import configSchema from '../../main/resources/report/json/config-v2.schema.json' with { type: 'json' };
import { parseConfig } from '../../main/ts/cli/config.js';
import { analyzeSnapshot } from './helpers/analysis.js';
import { effectivePlugins } from '../../main/ts/compose/plugin-list.js';
import { languageRegistry } from '../../main/ts/compose/languages.js';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import { sourceFile, sourceFiles, workingSnapshot } from '@repometry/core/internal/model/snapshot.js';
import { inspectionProfileDigest } from '../../main/ts/report/json/projections/inspection-context.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';

const javascript = { id: 'javascript', label: 'Alternate JS', extensions: ['.js'] };
const go = { id: 'go', label: 'Alternate Go', extensions: ['.go'] };
const choices = [
  javascript, { id: 'typescript', label: 'Alternate TS', extensions: ['.ts'] }, go,
  { id: 'python', label: 'Alternate Python', extensions: ['.py'] },
  { id: 'rust', label: 'Rust', extensions: ['.rs'] },
];

function alternate(providesLanguages: readonly ProvidedLanguage[]): Plugin {
  return { id: 'alternative', version: '1.0.0', api: pluginApi, kinds: ['language'], providesLanguages,
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'parse', role: 'provider', inputs: { source: sourceFile }, output: codeStructure,
      execute: context => ({ path: context.read('source', sourceFile).path, lines: 1, functions: 0 }) }] };
}

function analyze(files: Readonly<Record<string, string>>, plugin: Plugin, parsers?: Readonly<Record<string, readonly string[]>>): Promise<Report> {
  const snapshot = workingSnapshot(Object.entries(files).map(([path, source]) => ({ path, bytes: Buffer.from(source) })));
  const languages = languageRegistry([plugin], parsers);
  return analyzeSnapshot({ snapshot, excludedOutput: null }, [plugin], undefined, undefined, languages);
}

function providers(report: Report) {
  return report.pluginData?.inventory?.map(({ path, provider }) => [path, provider]);
}

function reportedPlugins(report: Report) {
  return report.appliedConfig.plugins as readonly Pick<Plugin, 'id' | 'claims'>[];
}

test('assigns built-ins and a multi-language plugin side by side', async () => {
  const report = await analyze({ 'a.js': 'export const a = 1;', 'a.ts': 'export const a: number = 1;',
    'a.go': 'package sample\nfunc F() {}', 'a.py': 'def f(): pass', 'a.rs': 'fn main() {}' }, alternate(choices),
    { javascript: ['babel-syntax'], typescript: ['babel-syntax'], go: ['tree-sitter'], python: ['tree-sitter'] });
  assert.deepEqual(providers(report), [['a.go', 'tree-sitter/parse'], ['a.js', 'babel-syntax/parse'], ['a.py', 'tree-sitter/parse'],
    ['a.rs', 'alternative/parse'], ['a.ts', 'babel-syntax/parse']]);
  assert.deepEqual(report.appliedConfig.parser, { sourceType: 'unambiguous', errorRecovery: false, attachComment: false });
});

test('the ordered Go parser list falls back when the first optional parser is unavailable', async () => {
  const files = { 'main.go': 'package main\nfunc main() {}' };
  const parsers = { go: ['alternative', 'tree-sitter'] };
  const plugin = alternate([go]);
  const first = await analyze(files, plugin, parsers);
  assert.deepEqual(providers(first), [['main.go', 'alternative/parse']]);

  const unavailable = { ...plugin, operations: [], unavailableReason: 'Optional parser unavailable' };
  const second = await analyze(files, unavailable, parsers);
  assert.deepEqual(providers(second), [['main.go', 'tree-sitter/parse']]);
  assert.equal(reportedPlugins(second).some(({ id }) => id === plugin.id), false);
  assert.notEqual(inspectionProfileDigest(first), inspectionProfileDigest(second));

  const noFallback = await analyze(files, unavailable, { go: ['alternative'] });
  assert.deepEqual(noFallback.scope, { files: 1, parsed: 0 });
  assert.deepEqual(providers(noFallback), [['main.go', undefined]]);
  assert.equal(noFallback.pluginData?.inventory?.[0]?.analysed, false);
  const mixed = await analyze({ ...files, 'main.js': 'export const answer = 42;' }, unavailable, { go: ['alternative'] });
  const summary = commitSummary(mixed);
  assert.deepEqual(mixed.scope, { files: 2, parsed: 1 });
  assert.equal(summary.lines, null);
  assert.equal(summary.functions, null);
  assert.equal(summary.maxComplexity, null);
});

test('the chosen JavaScript parser leaves the security inspection active', async () => {
  const report = await analyze({ 'source.js': 'eval(input);' }, alternate([javascript]), { javascript: ['alternative'] });
  assert.deepEqual(providers(report), [['source.js', 'alternative/parse']]);
  assert.ok(report.findings?.some(finding => finding.tool === 'js-security' && finding.rule === 'eval'));
});

test('a parse failure does not try the next parser', async () => {
  const plugin = alternate([javascript]);
  const operation = { ...plugin.operations[0]!, execute() { throw new Error('parser failed'); } };
  const parsers = { javascript: ['alternative', 'babel-syntax'] };
  const report = await analyze({ 'source.js': 'const value = 1;' }, { ...plugin, operations: [operation] }, parsers);
  assert.equal(report.status, 'partial');
  assert.deepEqual(providers(report), [['source.js', 'alternative/parse']]);
  assert.ok(report.diagnostics.some(({ operation, message }) => operation === 'alternative/parse' && message === 'parser failed'));
});

test('the chosen parser supplies the language catalog and file claims', async () => {
  const language = { ...javascript, extensions: ['.alt'], color: '#123456' };
  const report = await analyze({ 'source.js': 'const value = 1;', 'source.alt': 'fixture' }, alternate([language]),
    { javascript: ['alternative'] });
  assert.deepEqual(providers(report), [['source.alt', 'alternative/parse'], ['source.js', undefined]]);
  assert.deepEqual(report.pluginData?.languages?.filter(({ id }) => id === 'javascript'),
    [{ id: 'javascript', label: 'Alternate JS', color: '#123456' }]);
});

test('a chosen provider inspects only the files it parses without a parser order', async () => {
  const provider = alternate([{ id: 'rust', label: 'Rust', extensions: ['.rs'] }]);
  const inspected: string[] = [];
  const plugin: Plugin = { ...provider, kinds: ['language', 'analysis'], claims: { extensions: ['.rs', '.toml'] },
    produces: [...provider.produces, { contract: findingResult.id, persistence: 'report' }],
    operations: [...provider.operations, { id: 'check', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
      execute: context => {
        inspected.push(context.read('source', sourceFile).path);
        return { measurements: [], findings: [] };
      } }],
  };
  await analyze({ 'main.rs': 'fn main() {}', 'Cargo.toml': '[package]' }, plugin);
  assert.deepEqual(inspected, ['main.rs']);
});

test('chosen parsers of different languages cannot both claim a Go file', async () => {
  await assert.rejects(async () => analyze({ 'main.go': 'package main' }, alternate([{ ...go, id: 'other' }])),
    { message: 'Parsers tree-sitter and alternative both include main.go' });
});

test('missing parser precedence names the contenders in registration order', async () => {
  await assert.rejects(async () => analyze({}, alternate([javascript])),
    { message: 'parsers/javascript is required to choose among babel-syntax, alternative' });
});

test('parser config rejects bad language and plugin references at their exact paths', () => {
  for (const [parsers, message] of [
    [{ unknown: ['babel-syntax'] }, 'Config parsers/unknown names an unknown language'],
    [{ go: ['missing'] }, 'Config parsers/go/0 names unknown plugin missing; go is provided by tree-sitter'],
    [{ go: ['babel-syntax'] }, 'Config parsers/go/0 names plugin babel-syntax, which does not provide go; go is provided by tree-sitter'],
  ] as const) {
    assert.throws(() => parseConfig({ parsers }), { message });
  }
});

test('the config schema and parser require nonempty lists of unique plugin ids', () => {
  const validate = new Ajv2020().compile(configSchema);
  assert.ok(validate({ parsers: { go: ['tree-sitter'] } }));
  assert.equal(validate({ parsers: { 'Go Lang': ['tree-sitter'] } }), false);
  for (const go of [[], [2], ['tree-sitter', 'tree-sitter']]) {
    const config = { parsers: { go } };
    assert.equal(validate(config), false);
    assert.throws(() => parseConfig(config), { message: 'Config parsers/go must be a nonempty list of unique plugin IDs' });
  }
});

test('analyze, plugins and review use the parser order from repometry.config.json', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-parser-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(root, 'source.js'), 'export const n = 1;\n');
  git('add', 'source.js');
  git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'parser.json'), JSON.stringify({ schema: 'urn:repometry:schema:plugin:1', id: 'alternative',
    category: 'language', version: '1.0.0', scope: 'file', image: 'sha256:' + 'a'.repeat(64), command: ['fixture'],
    tools: { fixture: '1' }, languages: [{ id: javascript.id, label: javascript.label, include: ['**/*.js'] }] }));
  await writeFile(join(root, 'repometry.config.json'), JSON.stringify({
    parsers: { javascript: ['babel-syntax'] }, plugins: ['./parser.json'],
  }));
  const cli = resolve('target/main/ts/cli/main.js');
  for (const args of [['analyze'], ['plugins'], ['review', 'HEAD']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const shown = spawnSync(process.execPath, [cli, 'show', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(providers(JSON.parse(shown.stdout)), [['source.js', 'babel-syntax/parse']]);
});

test('the profile changes when an already active provider takes another language', async () => {
  const shared = { id: 'shared', label: 'Shared', extensions: ['.shared'] };
  const first = { ...alternate([shared, { id: 'first', label: 'First', extensions: ['.first'] }]), id: 'first-parser' };
  const second = { ...alternate([shared, { id: 'second', label: 'Second', extensions: ['.second'] }]), id: 'second-parser' };
  const plugins = [first, second];
  const snapshot = workingSnapshot(['a.first', 'b.second', 'c.shared'].map(path => ({ path, bytes: Buffer.from('fixture') })));
  const input = { snapshot, excludedOutput: null };
  const inspect = (preferred: readonly string[]) =>
    analyzeSnapshot(input, plugins, undefined, undefined, languageRegistry(plugins, { shared: preferred }));
  const before = await inspect([first.id, second.id]);
  const after = await inspect([second.id, first.id]);
  assert.deepEqual(providers(before)?.at(-1), ['c.shared', 'first-parser/parse']);
  assert.deepEqual(providers(after)?.at(-1), ['c.shared', 'second-parser/parse']);
  assert.notEqual(inspectionProfileDigest(before), inspectionProfileDigest(after));
});

test('a chosen provider still conflicts when its parser is unavailable', async () => {
  const other = alternate([{ ...go, id: 'other' }]);
  const unavailable = { ...other, operations: [], unavailableReason: 'Optional parser unavailable' };
  await assert.rejects(async () => analyze({ 'main.go': 'package main' }, unavailable),
    { message: 'Parsers tree-sitter and alternative both include main.go' });
});

test('an unchosen parser retains its inspection operations and provenance', async () => {
  const provider = alternate([go]);
  const check = {
    id: 'check', role: 'inspection' as const, inputs: { source: sourceFile }, output: findingResult,
    execute: (inputs: Parameters<(typeof provider.operations)[number]['execute']>[0]) => {
      const { path } = inputs.read('source', sourceFile);
      return { measurements: [], findings: [{ tool: 'alternative', rule: 'kept', category: 'lint', level: 'low', message: 'A finding', path }] };
    },
  };
  const plugin: Plugin = { ...provider, kinds: ['language', 'analysis'], claims: { extensions: ['.go'] },
    produces: [...provider.produces, { contract: findingResult.id, persistence: 'report' }],
    rules: [{ id: 'kept', category: 'lint' }], operations: [...provider.operations, check] };
  const report = await analyze({ 'main.go': 'package main' }, plugin, { go: ['tree-sitter'] });
  assert.ok(report.findings?.some(({ tool, rule }) => tool === 'alternative' && rule === 'kept'));
  assert.deepEqual(reportedPlugins(report).find(({ id }) => id === plugin.id)?.claims, plugin.claims);
  assert.deepEqual(effectivePlugins([plugin], { go: ['tree-sitter'] }).find(({ id }) => id === plugin.id)?.include, ['**/*.go']);
});

test('an unchosen parser manifest is validated', async () => {
  await assert.rejects(async () => analyze({}, { ...alternate([go]), produces: [] }, { go: ['tree-sitter'] }),
    { message: 'Undeclared output for alternative/parse: repometry.code-structure/v1' });
});

function saved(report: Report) {
  const { generatedAt: _, ...rest } = report;
  return JSON.stringify(rest);
}

test('a redundant parser entry yields the same report bytes', async () => {
  const plugin = alternate([{ id: 'rust', label: 'Rust', extensions: ['.rs'] }]);
  const files = { 'main.rs': 'fn main() {}', 'main.js': 'export const n = 1;' };
  const base = await analyze(files, plugin);
  assert.equal(saved(await analyze(files, plugin, { rust: ['alternative'] })), saved(base));
  assert.equal(saved(await analyze(files, plugin, { javascript: ['babel-syntax'] })), saved(base));
});

test('the order of unused fallbacks does not change the report', async () => {
  const first = { ...alternate([go]), id: 'fallback-first' };
  const second = { ...alternate([go]), id: 'fallback-second' };
  const plugins = [first, second];
  const input = { snapshot: workingSnapshot([{ path: 'main.go', bytes: Buffer.from('package main') }]), excludedOutput: null };
  const inspect = (order: readonly string[]) =>
    analyzeSnapshot(input, plugins, undefined, undefined, languageRegistry(plugins, { go: order }));
  assert.equal(saved(await inspect(['tree-sitter', first.id, second.id])), saved(await inspect(['tree-sitter', second.id, first.id])));
});

test('plugin listing includes all registered parsers while the report records the chosen parser', async () => {
  const plugin = alternate([go]);
  const parsers = { go: ['alternative', 'tree-sitter'] };
  const report = await analyze({ 'main.go': 'package main' }, plugin, parsers);
  const onlyGo = (entries: readonly { readonly id: string; readonly providesLanguages?: readonly { readonly id: string }[] }[]) =>
    entries.filter(entry => entry.providesLanguages?.some(({ id }) => id === 'go')).map(({ id }) => id);
  assert.deepEqual(onlyGo(effectivePlugins([plugin], parsers).map(({ id, languages }) => ({ id, providesLanguages: languages }))), ['tree-sitter', 'alternative']);
  assert.deepEqual(onlyGo(JSON.parse(JSON.stringify(report.appliedConfig.plugins))), ['alternative']);
});

test('a parser left out of the selection is absent from the inspection profile', async () => {
  const plugin = alternate([go]);
  const parsers = { go: ['tree-sitter'] };
  const report = await analyze({}, plugin, parsers);
  assert.equal(reportedPlugins(report).some(({ id }) => id === plugin.id), false);
  const available = effectivePlugins([plugin], parsers).find(({ id }) => id === plugin.id);
  assert.deepEqual(available?.languages?.map(({ id }) => id), ['go']);
});

test('a partially selected batch parser inspects only its assigned files', async () => {
  const shared = { id: 'shared', label: 'Shared language', extensions: ['.shared'] };
  const own = { id: 'own', label: 'Owned language', extensions: ['.own'] };
  const parser = { ...alternate([shared]), id: 'first-choice' };
  const batch = alternate([shared, own]);
  const read = (context: Parameters<(typeof batch.operations)[number]['execute']>[0]) =>
    context.read('files', sourceFiles).map(({ path }) => path);
  const parsed: string[][] = [];
  const inspected: string[][] = [];
  const plugins: readonly Plugin[] = [parser, {
    ...batch, kinds: ['language', 'analysis'],
    produces: [{ contract: codeStructures.id, persistence: 'transient' }, { contract: findingResult.id, persistence: 'report' }],
    operations: [
      { id: 'parse', role: 'provider', scope: 'repository', inputs: { files: sourceFiles }, output: codeStructures,
        execute: context => {
          const paths = read(context);
          parsed.push(paths);
          return paths.map(path => ({ path, lines: 1, functions: 0 }));
        } },
      { id: 'check', role: 'inspection', scope: 'repository', inputs: { files: sourceFiles }, output: findingResult,
        execute: context => {
          inspected.push(read(context));
          return { measurements: [], findings: [] };
        } },
    ],
  }];
  const snapshot = workingSnapshot(['a.own', 'b.shared'].map(path => ({ path, bytes: Buffer.from('fixture') })));
  await analyzeSnapshot({ snapshot, excludedOutput: null }, plugins, undefined, undefined,
    languageRegistry(plugins, { shared: [parser.id] }));
  assert.deepEqual(parsed, [['a.own']]);
  assert.deepEqual(inspected, [['a.own']]);
});
