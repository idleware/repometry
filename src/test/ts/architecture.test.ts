import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';

const source = resolve('src/main/ts');
const exceptions = resolve('src/test/resources/architecture/legacy-edges.txt');

const dependencies: Readonly<Record<string, readonly string[]>> = {
  core: [],
  plugins: ['core'],
  'api/git': ['core', 'report/json'],
  'api/gh': ['core'],
  'api/import': ['core'],
  'api/process': ['core'],
  'api/worker': ['core', 'report/json'],
  'report/json/wire': [],
  'report/json': ['core', 'report/json/wire'],
  'report/html/app': ['report/json/wire'],
  'report/html/site': ['core', 'report/json', 'report/json/wire'],
  compose: ['core', 'plugins', 'api/git', 'api/gh', 'api/import', 'api/worker', 'report/json', 'report/json/wire'],
  cli: ['compose', 'core', 'api/git', 'api/gh', 'api/import', 'api/worker', 'report/json', 'report/json/wire', 'report/html/site'],
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
  return origin === target || origin === 'entry' || sharedModelType || summaryType || (dependencies[origin]?.includes(target) ?? false);
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
