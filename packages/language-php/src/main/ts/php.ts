import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'anonymous_class', 'anonymous_function', 'arrow_function', 'break_statement', 'case_statement', 'catch_clause',
    'class_declaration', 'colon_block', 'compound_statement', 'const_declaration', 'continue_statement',
    'declaration_list', 'default_statement', 'do_statement', 'echo_statement', 'else_clause', 'else_if_clause',
    'enum_declaration', 'enum_declaration_list', 'expression_statement', 'finally_clause', 'for_statement',
    'foreach_statement', 'function_definition', 'if_statement', 'interface_declaration', 'match_block',
    'match_expression', 'method_declaration', 'property_declaration', 'return_statement', 'switch_block',
    'switch_statement', 'trait_declaration', 'try_statement', 'while_statement',
  ]),
  kinds: new Map([
    ['name', 'identifier'], ['variable_name', 'variable'], ['integer', 'integer'], ['float', 'float'],
    ['string', 'string'], ['encapsed_string', 'string'], ['heredoc', 'string'], ['nowdoc', 'string'],
    ['boolean', 'boolean'], ['null', 'null'],
  ]),
};

export const php: Grammar = {
  language: { id: 'php', label: 'PHP', color: '#4f5d95', extensions: ['.php'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'bytes',
  name: node => node.childForFieldName('name')?.text,
  rules: {
    function_definition: { flow: 'function' }, method_declaration: { flow: 'function', requiresBody: true },
    anonymous_function: { flow: 'function' }, arrow_function: { flow: 'function' },
    class_declaration: { flow: 'class' }, anonymous_class: { flow: 'class' },
    interface_declaration: { flow: 'class' }, trait_declaration: { flow: 'class' }, enum_declaration: { flow: 'class' },
    if_statement: { flow: 'if', decision: true }, else_if_clause: { flow: 'elif', decision: true },
    else_clause: { flow: 'else', chainedAlternative: true },
    for_statement: { flow: 'nest', decision: true }, foreach_statement: { flow: 'nest', decision: true },
    while_statement: { flow: 'nest', decision: true }, do_statement: { flow: 'nest', decision: true },
    catch_clause: { flow: 'nest', decision: true }, conditional_expression: { flow: 'nest', decision: true },
    switch_statement: { flow: 'nest' }, case_statement: { decision: true },
    match_expression: { flow: 'nest' }, match_conditional_expression: { decision: true },
    binary_expression: { decision: node => Number(node.childForFieldName('operator')?.type === '??') },
    augmented_assignment_expression: { decision: node => Number(node.childForFieldName('operator')?.type === '??=') },
    nullsafe_member_access_expression: { decision: true }, nullsafe_member_call_expression: { decision: true },
    break_statement: { exit: 'label' }, continue_statement: { exit: 'label' }, goto_statement: { exit: 'label' },
    return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments: new Set(['comment']),
  // Markup still contributes physical lines. Comparisons use only the PHP tokens.
  extras: new Set(['php_tag', 'text', 'text_interpolation']),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['&&', '||', 'and', 'or']), logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
