import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

const classTypes = ['class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'];
const functionTypes = [
  'method_declaration', 'constructor_declaration', 'destructor_declaration', 'local_function_statement',
  'operator_declaration', 'conversion_operator_declaration', 'accessor_declaration',
  'lambda_expression', 'anonymous_method_expression', 'property_declaration', 'indexer_declaration',
];
const controlBlocks = [
  'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'conditional_expression', 'catch_clause',
];
const directiveTypes = new Set(['preproc_if', 'preproc_elif', 'preproc_else']);
const comments = new Set(['comment']);

function conditionalBody(wrapper: Node): boolean {
  if (wrapper.type !== 'preproc_if') return false;
  for (let arm: Node | null = wrapper; arm && directiveTypes.has(arm.type); arm = arm.childForFieldName('alternative')) {
    if (arm.childForFieldName('body')) return true;
  }
  return false;
}

export function functionBody(node: Node): readonly Node[] {
  if (node.type === 'anonymous_method_expression') {
    return node.namedChildren.filter(child => child.type === 'block');
  }
  if (node.type === 'property_declaration' || node.type === 'indexer_declaration') {
    const value = node.childForFieldName('value');
    return value?.type === 'arrow_expression_clause' ? [value] : [];
  }
  const direct = node.childForFieldName('body');
  return direct ? [direct] : node.namedChildren.filter(conditionalBody);
}

function formalParameters(node: Node): number {
  return node.childrenForFieldName('parameters').reduce((count, entry) => {
    if (entry.type === 'implicit_parameter') return count + 1;
    if (entry.type !== 'parameter_list' && entry.type !== 'bracketed_parameter_list') return count;
    // The grammar flattens a params array's name beside wrapped parameters.
    return count + entry.childrenForFieldName('name').length +
      entry.namedChildren.filter(child => child.type === 'parameter').length;
  }, 0);
}

function accessorParameters(node: Node): number {
  const owner = node.parent?.parent;
  return owner?.type === 'indexer_declaration' ? formalParameters(owner) : 0;
}

function name(node: Node): string | undefined {
  const written = node.childForFieldName('name')?.text;
  switch (node.type) {
    case 'accessor_declaration': {
      const owner = node.parent?.parent;
      const member = owner?.type === 'indexer_declaration' ? 'this' : owner?.childForFieldName('name')?.text;
      return member && written ? member + '.' + written : written;
    }
    case 'property_declaration': return written && written + '.get';
    case 'indexer_declaration': return 'this.get';
    case 'destructor_declaration': return written && '~' + written;
    case 'operator_declaration':
    case 'conversion_operator_declaration': {
      const label = node.childForFieldName(node.type === 'operator_declaration' ? 'operator' : 'type')?.text;
      return label && 'operator ' + label;
    }
    default: return written;
  }
}

function alternativeBranches(wrapper: Node): readonly Node[] | undefined {
  if (wrapper.type !== 'preproc_if') return undefined;
  const alternatives: Node[] = [];
  for (let arm: Node | null = wrapper; arm && directiveTypes.has(arm.type); arm = arm.childForFieldName('alternative')) {
    const children = arm.children;
    const keyword = children.findIndex(child => child.type === 'else');
    const alternate = arm.childForFieldName('alternative');
    const statement = keyword < 0 ? undefined : children.slice(keyword + 1)
      .find(child => child.isNamed && child.id !== alternate?.id && !comments.has(child.type));
    if (statement) alternatives.push(statement);
  }
  return alternatives.length ? alternatives : undefined;
}

function switchArm(node: Node): number {
  const pattern = node.firstNamedChild;
  const catchAll = pattern?.type === 'discard' ||
    (pattern?.type === 'declaration_pattern' && pattern.childForFieldName('type')?.type === 'implicit_type');
  return Number(!catchAll);
}

function operatorDecision(operator: string): (node: Node) => number {
  return node => Number(node.childForFieldName('operator')?.type === operator);
}

const functionRule = { flow: 'function', requiresBody: true, body: functionBody, parameters: formalParameters } as const;

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    ...classTypes, ...functionTypes, ...controlBlocks,
    'block', 'declaration_list', 'expression_statement', 'field_declaration', 'if_statement',
    'local_declaration_statement', 'return_statement', 'switch_body', 'switch_expression',
    'switch_expression_arm', 'switch_section', 'switch_statement', 'try_statement',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['implicit_parameter', 'identifier'],
    ['integer_literal', 'integer'], ['real_literal', 'float'], ['character_literal', 'character'],
    ['string_literal', 'string'], ['verbatim_string_literal', 'string'], ['raw_string_literal', 'string'],
    ['string_content', 'string-fragment'], ['boolean_literal', 'boolean'], ['null_literal', 'null'],
  ]),
};

export const csharp: Grammar = {
  language: { id: 'csharp', label: 'C#', color: '#178600', extensions: ['.cs'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  lineBreaks: /\r\n|[\n\r]/g,
  columns: 'codepoints',
  name,
  recoverDeclarations: true,
  ignoredFields: { preproc_if: 'condition', preproc_elif: 'condition' },
  rules: {
    ...Object.fromEntries(classTypes.map(type => [type, { flow: 'class' }])),
    ...Object.fromEntries(functionTypes.map(type => [type, functionRule])),
    accessor_declaration: { ...functionRule, parameters: accessorParameters },
    if_statement: { flow: 'if', decision: true, alternativeBranches },
    ...Object.fromEntries(controlBlocks.map(type => [type, { flow: 'nest', decision: true }])),
    switch_statement: { flow: 'nest' },
    switch_expression: { flow: 'nest' },
    switch_section: { decision: node => Number(node.firstChild?.type === 'case') },
    switch_expression_arm: { decision: switchArm },
    when_clause: { decision: true },
    catch_filter_clause: { decision: true },
    binary_expression: { decision: operatorDecision('??') },
    assignment_expression: { decision: operatorDecision('??=') },
    return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']),
  comments,
  extras: new Set(),
  logicalTypes: new Set(['binary_expression']),
  logicalOperators: new Set(['&&', '||']),
  logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth',
  tokens,
};
