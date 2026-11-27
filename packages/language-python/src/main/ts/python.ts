import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };
import { pythonSource } from './python-source.js';
import { pythonSyntax } from './python-syntax.js';

type Node = Parameters<Grammar['name']>[0];

function irrefutable(pattern: Node): boolean {
  const pending = [pattern];
  while (pending.length) {
    const node = pending.pop()!;
    const inner = node.namedChildren;
    if (capturesAll(node, inner)) return true;
    if (node.type === 'union_pattern') {
      for (const child of inner) pending.push(child);
    } else {
      const child = groupedPattern(node, inner);
      if (child) pending.push(child);
    }
  }
  return false;
}

function capturesAll(node: Node, inner: readonly Node[]): boolean {
  switch (node.type) {
    case 'case_pattern': return inner.length === 0 && node.text === '_';
    case 'dotted_name': return inner.length === 1;
    case 'union_pattern': return node.children.some(child => child.type === '_');
    default: return false;
  }
}

function groupedPattern(node: Node, inner: readonly Node[]): Node | undefined {
  if (node.type === 'as_pattern' || node.type === 'case_pattern') return inner[0];
  if (node.type === 'tuple_pattern' && inner.length === 1 && !node.children.some(child => child.type === ',')) return inner[0];
}

function matchDecisions(node: Node): number {
  const patterns = node.namedChildren.filter(child => child.type === 'case_pattern');
  const captured = patterns.length === 1 && !node.children.some(child => child.type === ',') && irrefutable(patterns[0]!);
  return Number(!captured) + Number(node.childForFieldName('guard') !== null);
}

const names = new Set(['match', 'case', 'type', '__future__', 'print', 'exec']);

// Start with tokenize spellings and omit encoding, comments, indentation, line endings and continuations.
// Preserve keywords and punctuation. Treat match, case, type, __future__, print and exec as identifiers in
// all contexts. Retain _ literally, including when it is a wildcard. True and False share a boolean kind.
// The similar kinds are identifier, boolean, none, string, integer, float and imaginary. Each quoted string
// is one token; coalesce f-string components when the lexer splits them. A number ending in j/J is imaginary.
// Files under 12 code lines contribute no clone tokens. Each token is its UTF-16 code-unit length, a colon
// and the spelling. Similar fingerprints use !kind: for the listed kinds.
const tokens: Grammar['tokens'] = {
  candidates: new Set(['assert_statement', 'block', 'break_statement', 'case_clause', 'class_definition', 'continue_statement',
    'delete_statement', 'elif_clause', 'exec_statement', 'except_clause', 'except_group_clause', 'expression_statement', 'for_statement',
    'function_definition', 'global_statement', 'if_statement', 'lambda', 'match_statement', 'nonlocal_statement', 'pass_statement', 'print_statement',
    'raise_statement', 'return_statement', 'try_statement', 'type_alias_statement', 'while_statement', 'with_statement']),
  kinds: new Map([['identifier', 'identifier'], ['string', 'string'],
    ['integer', 'integer'], ['float', 'float'], ['true', 'boolean'], ['false', 'boolean'], ['none', 'none']]),
  normalize: (_type, text, kind) => [text, tokenKind(text, kind)],
};

function tokenKind(text: string, kind: string | undefined): string | undefined {
  if (text === '_') return undefined;
  if (names.has(text)) return 'identifier';
  return (kind === 'integer' || kind === 'float') && /j$/i.test(text) ? 'imaginary' : kind;
}

export const python: Grammar = {
  language: { id: 'python', label: 'Python', color: '#3572a5', extensions: ['.py'], measures: [...measures, 'classes'], syntax: pythonSyntax },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  decode: pythonSource, prepareSource: text => text.replace(/\r(?!\n)/g, '\n'),
  trimObservationComments: true, requireNonemptyBlock: 'block',
  columns: 'codepoints', name: node => node.childForFieldName('name')?.text.normalize('NFKC'),
  rules: {
    function_definition: { flow: 'function' }, lambda: { flow: 'function' }, class_definition: { flow: 'class' },
    decorated_definition: { flow: 'decorated' },
    if_statement: { flow: 'if', decision: true }, elif_clause: { flow: 'elif', decision: true }, else_clause: { flow: 'else' },
    for_statement: { flow: 'nest', decision: true }, while_statement: { flow: 'nest', decision: true },
    except_clause: { flow: 'nest', decision: true }, except_group_clause: { flow: 'nest', decision: true },
    conditional_expression: { flow: 'nest', decision: true, order: [1, 0, 2] },
    match_statement: { flow: 'nest' }, case_clause: { decision: matchDecisions },
    return_statement: { exit: 'return' }, list_comprehension: { flow: 'sequence' }, set_comprehension: { flow: 'sequence' },
    dictionary_comprehension: { flow: 'sequence' }, generator_expression: { flow: 'sequence' },
    for_in_clause: { flow: 'clause' }, if_clause: { flow: 'filter' },
  },
  parens: new Set(['parenthesized_expression']), comments: new Set(['comment']), extras: new Set(['line_continuation']),
  logicalTypes: new Set(['boolean_operator']), logicalOperators: new Set(['and', 'or']), logicalCognitive: 'sequence',
  parameterSeparators: new Set(['positional_separator', 'keyword_separator']), moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
