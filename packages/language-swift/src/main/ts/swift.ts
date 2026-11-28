import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];
type Rule = Grammar['rules'][string];

const typeKinds = new Set(['actor', 'class', 'enum', 'struct']);
const accessors = new Map([['computed_getter', 'get'], ['computed_setter', 'set'], ['computed_modify', '_modify']]);
const functions = ['function_declaration', 'init_declaration', 'deinit_declaration'];
const loops = ['for_statement', 'while_statement', 'repeat_while_statement'];
const comments = new Set(['comment', 'multiline_comment']);

function typeKind(node: Node): string | undefined {
  return node.childForFieldName('declaration_kind')?.type;
}

function completeType(node: Node): readonly Node[] {
  const body = typeKinds.has(typeKind(node) ?? '') ? node.childForFieldName('body') : null;
  return body ? [body] : [];
}

function statements(node: Node): readonly Node[] {
  return node.namedChildren.filter(child => child.type === 'statements');
}

// The opening brace distinguishes an empty executable body from an accessor requirement.
function accessorBody(node: Node): readonly Node[] {
  return node.children.filter(child => child.type === 'statements' || child.type === '{');
}

function implicitGetter(node: Node): readonly Node[] {
  return node.namedChildren.some(child => accessors.has(child.type)) ? [] : accessorBody(node);
}

function accessorOwner(node: Node): Node | null | undefined {
  return node.type === 'computed_property' ? node.parent : node.parent?.parent;
}

function simpleName(node: Node): string | undefined {
  if (node.type === 'lambda_literal') return undefined;
  if (node.type === 'init_declaration') return 'init';
  if (node.type === 'deinit_declaration') return 'deinit';
  const accessor = node.type === 'computed_property' ? 'get' : accessors.get(node.type);
  if (accessor) {
    const owner = accessorOwner(node);
    const property = owner?.type === 'subscript_declaration' ? 'subscript' : owner?.childForFieldName('name')?.text;
    return property && property + '.' + accessor;
  }
  return node.childForFieldName('name')?.text;
}

function name(node: Node): string | undefined {
  const own = simpleName(node);
  if (!own) return undefined;
  const names = [own];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'class_declaration' && typeKind(parent) === 'extension') {
      const extended = simpleName(parent);
      if (extended) names.unshift(extended);
      continue;
    }
    const rule = rules[parent.type];
    if (rule?.flow === 'class' || rule?.flow === 'function' &&
        (!rule.requiresBody || (rule.body?.(parent).length ?? Number(parent.childForFieldName('body') !== null)) > 0)) break;
  }
  return names.join('.');
}

function parameters(node: Node): number {
  return node.namedChildren.filter(child => child.type === 'parameter').length;
}

function closureParameters(node: Node): number {
  const signature = node.childForFieldName('type');
  const parameters = signature?.namedChildren.find(child => child.type === 'lambda_function_type_parameters');
  return parameters?.namedChildren.filter(child => child.type === 'lambda_parameter').length ?? 0;
}

function accessorParameters(node: Node): number {
  const owner = accessorOwner(node);
  const indexes = owner?.type === 'subscript_declaration' ? parameters(owner) : 0;
  return indexes + Number(node.type === 'computed_setter' && node.namedChildren.some(child => child.type === 'simple_identifier'));
}

function alternative(node: Node): Node | null {
  const children = node.children;
  const marker = children.findIndex(child => child.type === 'else');
  if (marker === -1) return null;
  return children.slice(marker + 1).find(child => child.isNamed && !comments.has(child.type)) ?? children[marker]!;
}

function extraConditions(node: Node): number {
  return node.children.filter(child => child.type === ',').length;
}

function switchDecisions(node: Node): number {
  const children = node.children;
  return Number(children.some(child => child.type === 'case')) +
    Number(children.some(child => child.type === 'where_keyword'));
}

const returns = { exit: 'return' } as const;
const labeledJump = { exit: 'label' } as const;

function transfer(node: Node): Rule | undefined {
  const kind = node.firstChild?.type;
  if (kind === 'return') return returns;
  if ((kind === 'break' || kind === 'continue') && node.childForFieldName('result')) return labeledJump;
  return undefined;
}

const rules: Grammar['rules'] = {
  class_declaration: { flow: 'class', requiresBody: true, body: completeType },
  protocol_declaration: { flow: 'class', requiresBody: true },
  ...Object.fromEntries(functions.map(type => [type, { flow: 'function', requiresBody: true, parameters }])),
  lambda_literal: { flow: 'function', body: statements, parameters: closureParameters },
  computed_property: { flow: 'function', requiresBody: true, body: implicitGetter, parameters: accessorParameters },
  ...Object.fromEntries([...accessors.keys()].map(type => [type,
    { flow: 'function', requiresBody: true, body: accessorBody, parameters: accessorParameters }])),
  ...Object.fromEntries(loops.map(type => [type, { flow: 'nest', decision: (node: Node) => 1 + extraConditions(node) }])),
  if_statement: { flow: 'if', decision: node => 1 + extraConditions(node), alternative },
  guard_statement: { flow: 'nest', decision: node => 1 + extraConditions(node) },
  switch_statement: { flow: 'nest' },
  switch_entry: { decision: switchDecisions },
  catch_block: { flow: 'nest', decision: true },
  where_clause: { decision: node => Number(node.parent?.type === 'catch_block' || node.parent?.type === 'for_statement') },
  ternary_expression: { flow: 'nest', decision: true },
  nil_coalescing_expression: { decision: true },
  control_transfer_statement: { select: transfer },
};

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'class_declaration', 'class_body', 'enum_class_body', 'protocol_declaration', 'protocol_body',
    ...functions, ...loops, ...accessors.keys(),
    'function_body', 'lambda_literal', 'computed_property', 'property_declaration', 'subscript_declaration',
    'statements', 'if_statement', 'guard_statement', 'switch_statement', 'switch_entry', 'catch_block',
    'do_statement', 'assignment', 'call_expression', 'control_transfer_statement',
  ]),
  kinds: new Map([
    ['simple_identifier', 'identifier'], ['type_identifier', 'identifier'],
    ['integer_literal', 'integer'], ['bin_literal', 'integer'], ['hex_literal', 'integer'], ['oct_literal', 'integer'],
    ['real_literal', 'float'], ['boolean_literal', 'boolean'],
    ['line_str_text', 'string-fragment'], ['multi_line_str_text', 'string-fragment'],
    ['str_escaped_char', 'string-fragment'], ['raw_str_part', 'raw-string-fragment'],
    ['raw_str_end_part', 'raw-string-fragment'],
  ]),
};

export const swift: Grammar = {
  language: { id: 'swift', label: 'Swift', color: '#f05138', extensions: ['.swift'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints',
  name,
  recoverDeclarations: true,
  rules,
  parens: new Set(['tuple_expression']),
  comments,
  extras: new Set(),
  logicalTypes: new Set(['conjunction_expression', 'disjunction_expression']),
  logicalOperators: new Set(['&&', '||']),
  logicalOperatorSpelling: true,
  logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module control-flow depth',
  tokens,
};
