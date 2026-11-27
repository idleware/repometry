import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';
import type { Node } from '@babel/types';
import { analysisPhases, diffCoveragePhases } from '../../main/ts/compose/phases.js';
import { structureMeasures } from '../../main/ts/core/model/code-structure.js';
import { fileTypes } from '../../main/ts/core/model/file-types.js';
import { findingCategories } from '../../main/ts/core/model/finding.js';
import { builtInPlugins, hostLanguages } from '../../main/ts/plugins/built-in.js';
import summarySchema from '../../main/resources/report/json/repository-summary-v1.schema.json' with { type: 'json' };

const source = resolve('src/main/ts');
const exceptions = resolve('src/test/resources/architecture/legacy-edges.txt');

const dependencies: Readonly<Record<string, readonly string[]>> = {
  core: [],
  plugins: ['core'],
  'api/cache': [],
  'api/git': ['api/cache', 'core', 'report/json'],
  'api/gh': ['core'],
  'api/import': ['core'],
  'api/process': ['api/cache', 'core'],
  'report/json/wire': [],
  'report/json': ['core', 'report/json/wire'],
  'report/html/app': ['report/json/wire'],
  'report/html/site': ['core', 'report/json', 'report/json/wire'],
  'report/markdown': ['core'],
  compose: ['core', 'api/git', 'api/gh', 'api/import', 'api/process', 'report/json', 'report/json/wire'],
  cli: ['compose', 'core', 'api/cache', 'api/git', 'api/gh', 'api/import', 'report/json', 'report/json/wire', 'report/html/site',
    'report/markdown'],
};

type Edge = { readonly from: string; readonly to: string; readonly kind: 'runtime' | 'type' };

function moduleOf(file: string): string {
  if (!file.includes('/')) return 'entry';
  const parts = file.split('/');
  const prefix = Object.keys(dependencies).find(name => file.startsWith(name + '/'));
  return prefix ?? parts[0]!;
}

function imports(files: readonly string[]): Edge[] {
  const paths = new Set(files);
  const edges: Edge[] = [];
  for (const from of files) {
    const code = readFileSync(join(source, from), 'utf8');
    const tree = parse(code, { sourceType: 'module', plugins: ['typescript', 'importAttributes'], createImportExpressions: true });

    function add(specifier: string | undefined, kind: Edge['kind']): void {
      if (specifier === undefined) return;
      if (from.startsWith('core/')) {
        assert.ok(!/^(?:node:)?(?:fs|child_process|http|https|net|tls|dgram|dns|worker_threads)(?:\/|$)/.test(specifier),
          `Platform I/O in ${from}: ${specifier}`);
      }
      if (from.startsWith('plugins/') && !from.startsWith('plugins/language-js/')) {
        assert.ok(!specifier.startsWith('@babel/'), `Babel dependency outside the language provider: ${from}`);
      }
      if (!specifier.startsWith('.') || !specifier.endsWith('.js')) return;
      const to = posix.normalize(posix.join(dirname(from), specifier.slice(0, -3) + '.ts'));
      assert.ok(paths.has(to), `Unresolved internal import from ${from} to ${specifier}`);
      edges.push({ from, to, kind });
    }

    for (const statement of tree.program.body) {
      if (statement.type !== 'ImportDeclaration' && statement.type !== 'ExportNamedDeclaration'
        && statement.type !== 'ExportAllDeclaration') continue;
      const typeOnly = statement.type === 'ImportDeclaration'
        ? statement.importKind === 'type' || (statement.specifiers.length > 0
          && statement.specifiers.every(item => item.type === 'ImportSpecifier' && item.importKind === 'type'))
        : statement.exportKind === 'type' || (statement.type === 'ExportNamedDeclaration' && statement.specifiers.length > 0
          && statement.specifiers.every(item => item.type === 'ExportSpecifier' && item.exportKind === 'type'));
      add(statement.source?.value, typeOnly ? 'type' : 'runtime');
    }
    traverseFast(tree, node => {
      if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') add(node.source.value, 'runtime');
    });
  }
  return edges;
}

function allowed({ from, to, kind }: Edge): boolean {
  const origin = moduleOf(from);
  const target = moduleOf(to);
  const sharedModelType = kind === 'type' && origin === 'report/json/wire' && to.startsWith('core/model/');
  const summaryType = kind === 'type' && origin === 'api/git' && to === 'report/json/wire/summary-model.ts';
  // The one edge from compose to plugins: compose reads the built-ins from the composition root only.
  const compositionRoot = from === 'compose/built-ins.ts' && to === 'plugins/built-in.ts';
  return origin === target || (origin === 'entry' && target !== 'plugins') || sharedModelType || summaryType || compositionRoot
    || (dependencies[origin]?.includes(target) ?? false);
}

function assertAcyclic(files: readonly string[], edges: readonly Edge[]): void {
  const outgoing = new Map(files.map(file => [file, [] as string[]]));
  for (const { from, to, kind } of edges) {
    if (kind === 'runtime') outgoing.get(from)!.push(to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(file: string): void {
    if (visited.has(file)) return;
    assert.ok(!visiting.has(file), `Runtime import cycle: ${[...visiting, file].join(' → ')}`);
    visiting.add(file);
    for (const target of outgoing.get(file)!) visit(target);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
}

test('module imports match their declared boundaries and runtime imports are acyclic', () => {
  const files = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
  const edges = imports(files);
  const actual = [...new Set(edges.filter(edge => !allowed(edge))
    .map(({ from, to, kind }) => `${kind} ${from} → ${to}`))].sort();
  const baseline = readFileSync(exceptions, 'utf8').split('\n').filter(Boolean).sort();
  assert.deepEqual(actual, baseline);
  assertAcyclic(files, edges);
});

// Core and compose name no plugin: ids come from the composition root, never from a list kept here.
const pluginIds = new Set([...builtInPlugins, ...hostLanguages].map(({ id }) => id));
const compositionRoot = { from: 'compose/built-ins.ts', to: 'plugins/built-in.ts' };

// Core's own words that happen to equal a plugin id. Each is allowed everywhere in core and compose, for its reason.
const vocabulary = new Map<string, string>([
  ...findingCategories.map(word => [word, 'a finding category'] as const),
  ...structureMeasures.map(word => [word, 'a structure measure a language provider declares'] as const),
  ...fileTypes.map(({ id }) => [id, 'a file type id'] as const),
  ...[analysisPhases(true), diffCoveragePhases].flatMap(phases => Object.values(phases).flatMap(({ offers }) => Object.keys(offers)))
    .map(word => [word, 'a host port name, which stored operation records contain'] as const),
].filter(([word]) => pluginIds.has(word)));
// A section of the stored repository summary, named by its schema, may name a field: an object key or a type member.
const fieldNames = new Set(propertyNames(summarySchema).filter(word => pluginIds.has(word)));

function propertyNames(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const own = 'properties' in schema && typeof schema.properties === 'object' && schema.properties ? Object.keys(schema.properties) : [];
  return [...own, ...Object.values(schema).flatMap(propertyNames)];
}

/** The text of a `+` chain of string literals, so an id split in two is still one literal. */
function constantText(node: Node): string | undefined {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type !== 'BinaryExpression' || node.operator !== '+' || node.left.type === 'PrivateName') return undefined;
  const [left, right] = [constantText(node.left), constantText(node.right)];
  return left === undefined || right === undefined ? undefined : left + right;
}

/** The node that names a field: an object or class key, a type member, or the literal of an indexed access type. */
function fieldKey(node: Node): Node | undefined {
  const member = node.type === 'ObjectProperty' || node.type === 'ObjectMethod' || node.type === 'ClassProperty' || node.type === 'TSPropertySignature';
  if (member && !node.computed) return node.key;
  return node.type === 'TSIndexedAccessType' && node.indexType.type === 'TSLiteralType' ? node.indexType.literal : undefined;
}

interface Violation { readonly file: string; readonly line: number; readonly what: string }

/**
 * The violations of the plugin boundary in one source file of `src/main/ts`, given by its path there and its text. Core,
 * compose and the entry points refer to no file in `plugins/` but through the composition root; core and compose name no
 * built-in plugin, and compose writes no contract id.
 */
function pluginBoundaryViolations(file: string, text: string): Violation[] {
  const inCompose = file.startsWith('compose/');
  const namesChecked = inCompose || file.startsWith('core/');
  if (!namesChecked && file.includes('/')) return [];
  const found: Violation[] = [];
  const report = (node: Node, what: string) => found.push({ file, line: node.loc?.start.line ?? 0, what });
  // Any literal path counts: an import, a re-export, `import()`, `require`, `import x = require`, `new URL` or `import.meta.resolve`.
  const path = (node: Node, value: string) => {
    const target = value.startsWith('.') ? posix.normalize(posix.join(dirname(file), value)).replace(/\.js$/, '.ts') : '';
    const allowed = file === compositionRoot.from && target === compositionRoot.to;
    if (/^plugins(\/|$)/.test(target) && !allowed) report(node, `refers to ${target}`);
  };
  const keys = new Set<Node>();
  const literal = (node: Node, value: string) => {
    path(node, value);
    if (!namesChecked) return;
    const allowed = (name: string) => vocabulary.has(name) || (keys.has(node) && fieldNames.has(name));
    const id = [...pluginIds].find(name => value.startsWith(`${name}/`) || (value === name && !allowed(name)));
    if (id) report(node, `names the built-in plugin ${id} in '${value}'`);
    else if (inCompose && /^repometry\.[a-z0-9-]+\/v\d+$/.test(value)) report(node, `writes the contract id '${value}'`);
  };
  traverseFast(parse(text, { sourceType: 'module', plugins: ['typescript', 'importAttributes'], createImportExpressions: true }), node => {
    const key = fieldKey(node);
    if (key) keys.add(key);
    if (key?.type === 'Identifier') literal(key, key.name);
    const value = node.type === 'TemplateLiteral' ? node.quasis[0]?.value.cooked : constantText(node);
    if (value !== undefined) literal(node, value);
  });
  return found;
}

const mustReport: readonly (readonly [file: string, snippet: string])[] = [
  ['compose/review.ts', "import { structure } from '../plugins/structure/structure.js';"],
  ['core/engine/plan.ts', "import type { Plugin } from '../../plugins/built-in.js';"],
  ['compose/inspect.ts', "export { coverage } from '../plugins/coverage/coverage.js';"],
  ['core/model/report.ts', "export * from '../../plugins/security/secrets.js';"],
  ['compose/review.ts', "const plugin = await import('../plugins/duplication/duplication.js');"],
  ['core/usecases/review.ts', "const scanner = require('../../plugins/security/secrets.js');"],
  ['compose/sources.ts', "import forges = require('../plugins/source/forges.js');"],
  ['compose/inspect.ts', "import { builtInPlugins } from '../plugins/built-in.js';"],
  ['core/model/quality-summary.ts', "const plugin = 'maintainability';"],
  ['compose/analysis-files.ts', 'const plugin = `js-security`;'],
  ['core/model/report.ts', 'const skips = { secrets: 1 };'],
  ['core/model/report.ts', "const plugins = { maintainability: 'maintainability' };"],
  ['compose/languages.ts', "const skips = { 'diff-coverage': true };"],
  ['core/usecases/review.ts', "const ignored = 'lcov/import';"],
  ['compose/phases.ts', 'const key = `maintainability/${operation}`;'],
  ['compose/sources.ts', "const fallback = 'local';"],
  ['core/model/report.ts', "const plugin = 'maintain' + 'ability';"],
  ['compose/diff-coverage.ts', "const result = 'repometry.diff-coverage-result/v1';"],
  ['plugin.ts', "export { structure } from './plugins/structure/structure.js';"],
  ['index.ts', "import type { Plugin } from './plugins/built-in.js';"],
  ['compose/languages.ts', "const script = new URL('../plugins/language-js/syntax.js', import.meta.url);"],
  ['core/engine/execute.ts', "const module = import.meta.resolve('../../plugins/coverage/coverage.js');"],
  ['core/model/language.ts', "interface Seen { readonly 'go-ast': number }"],
];

const mustPass: readonly (readonly [file: string, snippet: string])[] = [
  ['core/model/report.ts', "// the maintainability plugin and lcov/import are named in comments only\n/* 'structure/size' */ const a = 1;"],
  ['core/model/quality-summary.ts', "const smell = (category: string) => category === 'duplication' || category === 'structure';"],
  ['compose/phases.ts', 'const offers = { sources: cloneSources, lcov: lcovInput };'],
  ['core/model/file-types.ts', "const type = { id: 'dockerfile', label: 'Dockerfile' };"],
  ['core/model/code-structure.ts', "const measures = { duplication: 'duplication' };"],
  ['core/model/quality-summary.ts', "type Section = QualitySummary['maintainability']; const summary = { maintainability: grade };"],
  ['compose/sources.ts', "const words = ['localhost', 'structured', 'github-actions', 'my-maintainability'];"],
  ['cli/main.ts', "import { structure } from '../plugins/structure/structure.js'; const id = 'maintainability';"],
  ['report/json/projections/inspection-context.ts', "export const legacySyntaxPlugin = 'babel-syntax';"],
  ['compose/built-ins.ts', "import { builtInPlugins, hostLanguages } from '../plugins/built-in.js';"],
  ['core/model/coverage-input.ts', "export const lcovInput = { id: 'repometry.lcov-input/v1' };"],
  ['compose/analysis-files.ts', "import { plan } from '../core/engine/plan.js'; import { extname } from 'node:path';"],
  ['plugin.ts', "export { pluginApi } from './core/engine/plugin.js'; const name = 'maintainability';"],
  ['compose/native-language-plugins.ts', "const script = new URL('../../resources/go/parser.go', import.meta.url);"],
  ['compose/phases.ts', 'const key = `${plugin.id}/${operation.id}`;'],
];

test('the plugin boundary checker reports each way of naming a plugin from core or compose', () => {
  for (const [file, snippet] of mustReport) {
    assert.equal(pluginBoundaryViolations(file, snippet).length, 1, `${file}: ${snippet}`);
  }
});

test('the plugin boundary checker passes comments, core vocabulary, longer words and files outside core and compose', () => {
  for (const [file, snippet] of mustPass) assert.deepEqual(pluginBoundaryViolations(file, snippet), [], `${file}: ${snippet}`);
  assert.ok(vocabulary.size > 0 && [...vocabulary.values()].every(Boolean));
});

test('core and compose name no built-in plugin and import no plugin module but the composition root', () => {
  const files = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
  const found = files.flatMap(file => pluginBoundaryViolations(file, readFileSync(join(source, file), 'utf8')));
  assert.deepEqual(found.map(({ file, line, what }) => `${file}:${line}: ${what}`), []);
});
