import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Operation, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure } from '@repometry/core/internal/model/code-structure.js';
import type { SourceFile } from '@repometry/core/internal/model/source.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import { duplicationSettings } from '@repometry/core/internal/profile/maintainability.js';
import type { Grammar } from './language.js';
import { SourceLines } from './source-lines.js';
import { Structure } from './structure.js';
import { firstSyntaxIssue } from './syntax-issue.js';
import { scanClones } from './tokens.js';

const parsers = new Map<Grammar, Promise<Parser>>();
let initialized: Promise<void> | undefined;

/** The tree-sitter language plugin for the given language units, which parse in that order of precedence. */
export function treeSitter(grammars: readonly Grammar[]): Plugin {
  const byExtension = new Map(grammars.flatMap(grammar => grammar.language.extensions!.map(extension => [extension, grammar] as const)));
  // At this depth the emitted `execute` keeps the text it had as a module constant: profiles digest that text.
  const operations: Operation[] = [{
    id: 'parse', role: 'provider', inputs: { file: sourceFile }, output: codeStructure,
    async execute(inputs) {
      const file = inputs.read('file', sourceFile);
      const grammar = byExtension.get(extname(file.path));
      if (!grammar) throw new Error('No grammar for ' + file.path);
      return inspectFile(file, grammar);
    },
  }];
  return {
    id: 'tree-sitter', version: '1.0.0', api: pluginApi, kinds: ['language'],
    providesLanguages: grammars.map(({ language }) => language),
    tools: { 'web-tree-sitter': '0.27.2', ...Object.fromEntries(grammars.map(({ tool }) => [tool.package, tool.version])) },
    settings: { duplication: { ...duplicationSettings, minTokens: duplicationSettings.minNodes } },
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations,
  };
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
  const facts = scanClones(path, tree, source, grammar);
  return { path, ...new Structure(grammar, source, facts.codeLines).measure(root), ...facts };
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
