import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

const comments = new Set(['comment']);
const typeDefinition = { flow: 'class', requiresBody: true } as const;
const executableBlock = { flow: 'nest', decision: true } as const;

function innerDeclarator(node: Node): Node | null {
  const child = node.childForFieldName('declarator');
  if (child || node.type !== 'parenthesized_declarator' && node.type !== 'attributed_declarator') return child;
  return node.namedChildren.find(item => item.type === 'identifier' || item.type.endsWith('_declarator')) ?? null;
}

function name(node: Node): string | undefined {
  if (node.type !== 'function_definition') return node.childForFieldName('name')?.text;
  for (let part = innerDeclarator(node); part; part = innerDeclarator(part)) {
    if (part.type === 'identifier') return part.text;
  }
}

function parameterCount(node: Node): number {
  let list: Node | null = null;
  // For a function returning a function pointer, the formal list closest to the name owns the definition.
  for (let part = innerDeclarator(node); part; part = innerDeclarator(part)) {
    if (part.type === 'function_declarator') list = part.childForFieldName('parameters');
  }
  const parameters = list?.namedChildren.filter(child => child.type === 'parameter_declaration'
    || child.type === 'variadic_parameter' || child.type === 'identifier') ?? [];
  const [first, second] = parameters;
  if (!second && first?.type === 'parameter_declaration' && !first.childForFieldName('declarator')
    && first.childForFieldName('type')?.text === 'void') return 0;
  return parameters.length;
}

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'case_statement', 'compound_statement', 'conditional_expression', 'declaration', 'do_statement',
    'else_clause', 'enum_specifier', 'enumerator_list', 'expression_statement', 'field_declaration_list',
    'for_statement', 'function_definition', 'if_statement', 'initializer_list', 'labeled_statement',
    'preproc_elif', 'preproc_else', 'preproc_function_def', 'preproc_if', 'preproc_ifdef', 'return_statement',
    'struct_specifier', 'switch_statement', 'type_definition', 'union_specifier', 'while_statement',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['field_identifier', 'identifier'], ['statement_identifier', 'identifier'],
    ['type_identifier', 'identifier'], ['number_literal', 'number'], ['char_literal', 'character'],
    ['string_literal', 'string'], ['true', 'boolean'], ['false', 'boolean'], ['null', 'null'], ['nullptr', 'null'],
  ]),
};

export const c: Grammar = {
  language: { id: 'c', label: 'C', color: '#555555', extensions: ['.c', '.h'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  lineBreaks: /\r\n|[\r\n]/g,
  columns: 'codepoints', name,
  recoverDeclarations: true,
  ignoredFields: { preproc_if: 'condition', preproc_elif: 'condition' },
  rules: {
    function_definition: { flow: 'function', requiresBody: true, parameters: parameterCount },
    struct_specifier: typeDefinition,
    union_specifier: typeDefinition,
    enum_specifier: typeDefinition,
    if_statement: { flow: 'if', decision: true },
    else_clause: { flow: 'else', chainedAlternative: true },
    for_statement: executableBlock,
    while_statement: executableBlock,
    do_statement: executableBlock,
    conditional_expression: executableBlock,
    switch_statement: { flow: 'nest' },
    case_statement: { decision: node => Number(node.firstChild?.type === 'case') },
    goto_statement: { exit: 'label' },
    return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments, extras: new Set(),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['&&', '||']), logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
