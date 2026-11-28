import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

const classTypes = ['struct_item', 'enum_item', 'union_item', 'trait_item'];
const functionTypes = ['function_item', 'closure_expression'];
const loops = ['for_expression', 'while_expression', 'loop_expression'];
const comments = new Set(['line_comment', 'block_comment']);

function name(node: Node): string | undefined {
  const simple = node.childForFieldName('name')?.text;
  if (!simple) return undefined;
  const scopes = [simple];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (classTypes.includes(parent.type) || functionTypes.includes(parent.type)) break;
    if (parent.type === 'mod_item') {
      const module = parent.childForFieldName('name')?.text;
      if (module) scopes.unshift(module);
    } else if (parent.type === 'impl_item') {
      const type = parent.childForFieldName('type')?.text;
      const trait = parent.childForFieldName('trait')?.text;
      if (type) scopes.unshift(trait ? `<${type} as ${trait}>` : type);
    }
  }
  return scopes.join('.');
}

function parameters(node: Node): number {
  const list = node.childForFieldName('parameters');
  if (!list) return 0;
  // A closure's bare underscore is anonymous. Its destructuring pattern is a single parameter.
  return list.children.filter(child =>
    child.type === '_' || (child.isNamed && !comments.has(child.type) && child.type !== 'attribute_item')).length;
}

function matchArm(node: Node): number {
  const pattern = node.childForFieldName('pattern')?.children.find(child => !comments.has(child.type));
  return Number(pattern !== undefined && pattern.type !== '_');
}

function hasField(field: string): (node: Node) => number {
  return node => Number(node.childForFieldName(field) !== null);
}

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    ...classTypes, ...functionTypes, ...loops,
    'block', 'declaration_list', 'expression_statement', 'if_expression', 'impl_item', 'let_declaration',
    'macro_definition', 'macro_invocation', 'match_arm', 'match_block', 'match_expression', 'mod_item', 'return_expression',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['type_identifier', 'identifier'], ['field_identifier', 'identifier'],
    ['integer_literal', 'integer'], ['float_literal', 'float'], ['char_literal', 'character'],
    ['string_literal', 'string'], ['raw_string_literal', 'string'], ['boolean_literal', 'boolean'],
  ]),
};

export const rust: Grammar = {
  language: { id: 'rust', label: 'Rust', color: '#dea584', extensions: ['.rs'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints',
  name,
  recoverDeclarations: true,
  rules: {
    ...Object.fromEntries(classTypes.map(type => [type, { flow: 'class', requiresBody: type !== 'struct_item' }])),
    ...Object.fromEntries(functionTypes.map(type => [type, { flow: 'function', requiresBody: true, parameters }])),
    ...Object.fromEntries(loops.map(type => [type, { flow: 'nest', decision: true }])),
    if_expression: { flow: 'if', decision: true },
    else_clause: { flow: 'else', chainedAlternative: true },
    match_expression: { flow: 'nest' },
    match_arm: { decision: matchArm },
    match_pattern: { decision: hasField('condition') },
    let_declaration: { decision: hasField('alternative') },
    let_chain: { decision: node => node.children.filter(child => child.type === '&&').length },
    try_expression: { decision: true },
    return_expression: { exit: 'return' },
    continue_expression: { exit: 'label' },
  },
  parens: new Set(['parenthesized_expression']),
  comments,
  extras: new Set(),
  logicalTypes: new Set(['binary_expression']),
  logicalOperators: new Set(['&&', '||']),
  logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module control-flow depth',
  tokens,
};
