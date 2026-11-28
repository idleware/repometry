import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

const comments = new Set(['line_comment', 'block_comment', 'shebang']);
const functionBody = (node: Node) => node.namedChildren.filter(child => child.type === 'function_body');
const classBody = (node: Node) => node.namedChildren.filter(child => child.type === 'class_body' || child.type === 'enum_class_body');
const constructorBody = (node: Node) => node.namedChildren.filter(child => child.type === 'block' || child.type === 'constructor_delegation_call');
const lambdaBody = (node: Node) => node.namedChildren.filter(child => child.type !== 'lambda_parameters' && !comments.has(child.type));

function functionParameters(node: Node): number {
  // The list also contains parameter modifiers and default expressions as separate children.
  const parameters = node.namedChildren.find(child => child.type === 'function_value_parameters');
  return parameters?.namedChildren.filter(child => child.type === 'parameter').length ?? 0;
}

function lambdaParameters(node: Node): number {
  const parameters = node.namedChildren.find(child => child.type === 'lambda_parameters');
  return parameters?.namedChildren.filter(child => child.type === 'variable_declaration' || child.type === 'multi_variable_declaration').length ?? 0;
}

function alternative(node: Node): Node | null {
  const children = node.children;
  const index = children.findIndex(child => child.type === 'else');
  return index < 0 ? null : children.slice(index + 1).find(child => !comments.has(child.type)) ?? null;
}

function name(node: Node): string | undefined {
  const declared = node.childForFieldName('name')?.text;
  if (declared) return declared;
  switch (node.type) {
    case 'companion_object': return 'Companion';
    case 'secondary_constructor': return 'constructor';
    case 'getter':
    case 'setter': {
      const property = node.parent?.namedChildren.find(child => child.type === 'variable_declaration');
      const identifier = property?.namedChildren.find(child => child.type === 'identifier')?.text;
      return identifier ? identifier + (node.type === 'getter' ? '.get' : '.set') : undefined;
    }
  }
}

const tokens: Grammar['tokens'] = {
  candidates: new Set(['anonymous_function', 'anonymous_initializer', 'assignment', 'block', 'call_expression',
    'catch_block', 'class_body', 'class_declaration', 'companion_object', 'do_while_statement',
    'enum_class_body', 'finally_block', 'for_statement', 'function_body', 'function_declaration',
    'getter', 'if_expression', 'lambda_literal', 'object_declaration', 'object_literal',
    'property_declaration', 'return_expression', 'secondary_constructor', 'setter', 'throw_expression',
    'try_expression', 'when_entry', 'when_expression', 'while_statement']),
  kinds: new Map([
    ['identifier', 'identifier'], ['number_literal', 'integer'], ['float_literal', 'float'],
    ['character_literal', 'character'], ['string_content', 'string_content'],
  ]),
  // The grammar gives these literal spellings the identifier node type.
  normalize: (_type, text, kind) => [text, kind === 'identifier' ? literalKind(text) : kind],
};

function literalKind(text: string): string {
  switch (text) {
    case 'true':
    case 'false': return 'boolean';
    case 'null': return 'null';
    default: return 'identifier';
  }
}

export const kotlin: Grammar = {
  language: { id: 'kotlin', label: 'Kotlin', color: '#a97bff', extensions: ['.kt', '.kts'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text.replace(/\r(?!\n)/g, '\n'),
  columns: 'codepoints', name,
  rules: {
    function_declaration: { flow: 'function', body: functionBody, parameters: functionParameters, requiresBody: true },
    anonymous_function: { flow: 'function', body: functionBody, parameters: functionParameters, requiresBody: true },
    lambda_literal: { flow: 'function', body: lambdaBody, parameters: lambdaParameters },
    secondary_constructor: { flow: 'function', body: constructorBody, parameters: functionParameters },
    getter: { flow: 'function', body: functionBody, requiresBody: true },
    setter: { flow: 'function', body: functionBody, requiresBody: true, parameters: () => 1 },
    class_declaration: { flow: 'class', body: classBody },
    object_declaration: { flow: 'class', body: classBody },
    companion_object: { flow: 'class', body: classBody },
    object_literal: { flow: 'class', body: classBody },
    if_expression: { flow: 'if', decision: true, alternative },
    for_statement: { flow: 'nest', decision: true },
    while_statement: { flow: 'nest', decision: true },
    do_while_statement: { flow: 'nest', decision: true },
    when_expression: { flow: 'nest' },
    when_entry: { decision: node => Number(node.childForFieldName('condition') !== null) },
    catch_block: { flow: 'nest', decision: true },
    binary_expression: { decision: node => Number(node.childForFieldName('operator')?.type === '?:') },
    return_expression: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments, extras: new Set(),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['&&', '||']), logicalCognitive: 'parent',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
