import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

export const cppExtensions = ['.cc', '.cpp', '.cxx', '.hpp', '.hh'] as const;
const comments = new Set(['comment']);
const types = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);
const functions = new Set(['function_definition', 'lambda_expression']);
const names = new Set([
  'identifier', 'field_identifier', 'qualified_identifier', 'destructor_name',
  'operator_name', 'operator_cast', 'template_function', 'template_method',
]);
const declaratorWrappers = new Set(['parenthesized_declarator', 'reference_declarator', 'attributed_declarator']);
const parameters = new Set([
  'parameter_declaration', 'optional_parameter_declaration', 'variadic_parameter_declaration', 'variadic_parameter', '...',
]);

function innerDeclarator(node: Node): Node | null {
  const child = node.childForFieldName('declarator');
  if (child || !declaratorWrappers.has(node.type)) return child;
  return node.namedChildren.find(item => names.has(item.type) || item.type.endsWith('_declarator')) ?? null;
}

function parameterList(node: Node): Node | null {
  let list: Node | null = null;
  // The innermost function declarator owns the parameters when the return type is itself callable.
  for (let part: Node | null = node; part; part = innerDeclarator(part)) {
    list = part.childForFieldName('parameters') ?? list;
  }
  return list;
}

function parameterCount(node: Node): number {
  const declarator = innerDeclarator(node);
  const entries = declarator && parameterList(declarator)?.children.filter(child => parameters.has(child.type));
  const [first, second] = entries || [];
  if (!second && first?.type === 'parameter_declaration' && !first.childForFieldName('declarator')
    && first.childForFieldName('type')?.text === 'void') return 0;
  return entries?.length ?? 0;
}

function declName(node: Node): string {
  let tail = node;
  while (tail.type === 'qualified_identifier') {
    const member = tail.childForFieldName('name');
    if (!member) break;
    tail = member;
  }
  const conversion = tail.type === 'operator_cast' ? parameterList(tail) : null;
  return conversion ? node.text.slice(0, conversion.startIndex - node.startIndex).trimEnd() : node.text;
}

function writtenName(node: Node): string | undefined {
  if (types.has(node.type)) return node.childForFieldName('name')?.text;
  if (node.type !== 'function_definition') return undefined;
  for (let part = innerDeclarator(node); part; part = innerDeclarator(part)) {
    if (names.has(part.type)) return declName(part);
  }
}

function name(node: Node): string | undefined {
  const written = writtenName(node);
  if (!written || written.startsWith('::')) return written;
  const namespaces: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (types.has(parent.type) || functions.has(parent.type)) return written;
    if (parent.type === 'namespace_definition') {
      const qualifier = parent.childForFieldName('name')?.text;
      if (qualifier) namespaces.unshift(qualifier);
    }
  }
  const prefix = namespaces.join('::');
  return !prefix || written.startsWith(prefix + '::') ? written : prefix + '::' + written;
}

function functionBody(node: Node): readonly Node[] {
  const body = node.childForFieldName('body');
  if (!body) return node.type === 'function_definition' ? node.namedChildren.filter(child => child.type === 'try_statement') : [];
  const initializers = node.namedChildren.find(child => child.type === 'field_initializer_list');
  return initializers ? [initializers, body] : [body];
}

const classRule = { flow: 'class', requiresBody: true } as const;
const functionRule = { flow: 'function', body: functionBody, requiresBody: true, parameters: parameterCount } as const;
const blockRule = { flow: 'nest', decision: true } as const;

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    ...types, ...functions,
    'case_statement', 'catch_clause', 'co_return_statement', 'compound_statement', 'conditional_expression',
    'declaration', 'declaration_list', 'do_statement', 'else_clause', 'enumerator_list', 'expression_statement',
    'field_declaration_list', 'field_initializer_list', 'for_range_loop', 'for_statement', 'if_statement',
    'initializer_list', 'labeled_statement', 'namespace_definition', 'preproc_elif', 'preproc_else', 'preproc_function_def',
    'preproc_if', 'preproc_ifdef', 'return_statement', 'switch_statement', 'template_declaration', 'throw_statement',
    'try_statement', 'type_definition', 'while_statement',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['field_identifier', 'identifier'], ['namespace_identifier', 'identifier'],
    ['statement_identifier', 'identifier'], ['type_identifier', 'identifier'], ['number_literal', 'number'],
    ['char_literal', 'character'], ['string_literal', 'string'], ['raw_string_literal', 'string'],
    ['true', 'boolean'], ['false', 'boolean'], ['null', 'null'], ['nullptr', 'null'],
  ]),
};

export const cpp: Grammar = {
  language: { id: 'cpp', label: 'C++', color: '#f34b7d', extensions: cppExtensions, measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  lineBreaks: /\r\n|[\r\n]/g,
  columns: 'codepoints', name,
  recoverDeclarations: true,
  ignoredFields: { preproc_if: 'condition', preproc_elif: 'condition' },
  rules: {
    function_definition: functionRule,
    lambda_expression: functionRule,
    class_specifier: classRule,
    struct_specifier: classRule,
    union_specifier: classRule,
    enum_specifier: classRule,
    if_statement: { flow: 'if', decision: true },
    else_clause: { flow: 'else', chainedAlternative: true },
    for_statement: blockRule,
    for_range_loop: blockRule,
    while_statement: blockRule,
    do_statement: blockRule,
    conditional_expression: blockRule,
    catch_clause: blockRule,
    switch_statement: { flow: 'nest' },
    case_statement: { decision: node => Number(node.firstChild?.type === 'case') },
    goto_statement: { exit: 'label' },
    return_statement: { exit: 'return' },
    co_return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments, extras: new Set(),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['&&', '||', 'and', 'or']), logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
