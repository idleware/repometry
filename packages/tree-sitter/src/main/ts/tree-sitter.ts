import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import { codeStructure, pluginManifestSchema } from '@repometry/core';
import type { Operation, PluginManifest } from '@repometry/core';
import { readStructure } from '@repometry/core/internal/engine/author-contracts.js';
import type { CodeStructure, StructureMeasure } from '@repometry/core/internal/model/code-structure.js';
import type { SourceFile } from '@repometry/core/internal/model/source.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import type { Grammar } from './language.js';
import { SourceLines } from './source-lines.js';
import { Structure } from './structure.js';
import { firstSyntaxIssue } from './syntax-issue.js';
import { scanClones } from './tokens.js';

const parsers = new Map<Grammar, Promise<Parser>>();
let initialized: Promise<void> | undefined;
const structureMeasures = new Set<StructureMeasure>([
  'functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'classes', 'structuralRules',
]);

type NativeManifest = PluginManifest & { readonly version: string; create(): Awaited<ReturnType<PluginManifest['create']>> };

/** The public manifest backed by one grammar. */
export function treeSitter(grammar: Grammar): NativeManifest {
  const byExtension = new Map(grammar.language.extensions!.map(extension => [extension, grammar] as const));
  // At this depth the emitted `execute` keeps the text it had as a module constant: profiles digest that text.
  const [parse] = [{
    id: 'parse', role: 'provider', inputs: { file: sourceFile }, output: codeStructure,
    async execute(inputs) {
      const file = inputs.read('file', sourceFile);
      const grammar = byExtension.get(extname(file.path));
      if (!grammar) throw new Error('No grammar for ' + file.path);
      return inspectFile(file, grammar);
    },
  }] satisfies [Operation];
  const { extensions, globs, measures, ...language } = grammar.language;
  return {
    schema: pluginManifestSchema, id: 'language-' + language.id.replaceAll('-', ''), category: 'language', version: '1.0.0',
    languages: [{ ...language, include: [...(extensions ?? []).map(ext => '**/*' + ext), ...(globs ?? [])],
      ...(measures === undefined ? {} : { measures: measures.map(measure => measure === 'structuralRules' ? 'checks' : measure) }) }],
    tools: { [grammar.tool.package]: grammar.tool.version },
    create: () => ({
      produces: [{ contract: codeStructure.id, persistence: 'transient' }],
      operations: [{ ...parse, implementation: parse.execute.toString(),
        execute: async inputs => readStructure(await parse.execute(inputs) as CodeStructure) }],
    }),
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
  const structure = grammar.language.measures?.some(measure => structureMeasures.has(measure)) !== false
    ? new Structure(grammar, source, facts.codeLines).measure(root) : { lines: source.count };
  const declarations = grammar.countDeclarations?.(root);
  return { path, ...structure, ...facts, ...(declarations === undefined ? {} : { declarations }) };
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
