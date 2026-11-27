import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import goManifest from '../../../resources/languages/go/grammar.json' with { type: 'json' };
import pythonManifest from '../../../resources/languages/python/grammar.json' with { type: 'json' };
import { pluginApi } from '../../core/engine/plugin.js';
import type { Plugin } from '../../core/engine/plugin.js';
import { codeStructure } from '../../core/model/code-structure.js';
import type { SourceFile } from '../../core/model/source.js';
import { sourceFile } from '../../core/model/snapshot.js';
import { duplicationSettings } from '../../core/profile/maintainability.js';
import type { Grammar } from './language.js';
import { go } from './languages/go.js';
import { python } from './languages/python.js';
import { SourceLines } from './source-lines.js';
import { Structure } from './structure.js';
import { firstSyntaxIssue } from './syntax-issue.js';
import { cloneSource, scanTokens } from './tokens.js';

const packages = new Map([[go, goManifest], [python, pythonManifest]]);
const grammars = [...packages.keys()];
const byExtension = new Map(grammars.flatMap(grammar => grammar.language.extensions!.map(extension => [extension, grammar] as const)));
const parsers = new Map<Grammar, Promise<Parser>>();
let initialized: Promise<void> | undefined;

export const treeSitter: Plugin = {
  id: 'tree-sitter', version: '1.0.0', api: pluginApi, kinds: ['language'],
  providesLanguages: grammars.map(({ language }) => language),
  tools: { 'web-tree-sitter': '0.27.2',
    ...Object.fromEntries([...packages.values()].map(manifest => [manifest.package, manifest.version])) },
  settings: { duplication: { ...duplicationSettings, minTokens: duplicationSettings.minNodes } },
  produces: [{ contract: codeStructure.id, persistence: 'transient' }],
  operations: [{
    id: 'parse', role: 'provider', inputs: { file: sourceFile }, output: codeStructure,
    async execute(inputs) {
      const file = inputs.read('file', sourceFile);
      const grammar = byExtension.get(extname(file.path));
      if (!grammar) throw new Error('No grammar for ' + file.path);
      return inspectFile(file, grammar);
    },
  }],
};

export function usedGrammarTools(plugin: Plugin, languages: ReadonlySet<string>) {
  return Object.fromEntries([...packages].filter(([grammar]) => languages.has(grammar.language.id))
    .map(([, manifest]) => [manifest.package, plugin.tools?.[manifest.package] ?? manifest.version]));
}

async function inspectFile({ path, bytes }: SourceFile, grammar: Grammar) {
  const text = grammar.decode?.(bytes) ?? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const source = new SourceLines(text, grammar.lineBreaks);
  const input = grammar.prepareSource(text);
  const parser = await parserFor(grammar);
  const tree = parser.parse(input);
  try {
    return extract(path, grammar, source, tree);
  } finally {
    tree?.delete();
  }
}

function extract(path: string, grammar: Grammar, source: SourceLines, tree: Tree | null) {
  if (!tree) throw new SyntaxError('No syntax tree at ' + source.location(0, grammar.columns));
  const root = tree.rootNode;
  if (root.hasError) {
    const { offset, reason } = firstSyntaxIssue(root, grammar);
    throw new SyntaxError(reason + ' at ' + source.location(offset, grammar.columns));
  }
  const header = grammar.requireFirst && firstHeader(root, grammar);
  if (grammar.requireFirst && (!header || header.type !== grammar.requireFirst)) {
    throw new SyntaxError('Expected a ' + grammar.requireFirst.replaceAll('_', ' ') +
      ' at ' + source.location(header ? header.startIndex : 0, grammar.columns));
  }
  const tokens = scanTokens(tree, source, grammar);
  const { codeLines, commentLines } = tokens;
  return { path, ...new Structure(grammar, source, codeLines).measure(root), codeLines, commentLines,
    clones: cloneSource(path, tokens, source, grammar) };
}

function firstHeader(root: Node, grammar: Grammar): Node | null {
  let node = root.firstNamedChild;
  while (node && grammar.comments.has(node.type)) node = node.nextNamedSibling;
  return node;
}

function parserFor(grammar: Grammar): Promise<Parser> {
  const existing = parsers.get(grammar);
  if (existing) return existing;
  const parser = makeParser(grammar);
  parsers.set(grammar, parser);
  void parser.catch(() => parsers.delete(grammar));
  return parser;
}

async function makeParser({ asset }: Grammar): Promise<Parser> {
  const { Language, Parser } = await import('web-tree-sitter');
  await (initialized ??= Parser.init());
  const language = await Language.load(await readFile(asset));
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
