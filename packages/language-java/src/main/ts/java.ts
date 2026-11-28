import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };
import { javaSyntax } from './java-syntax.js';

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'annotation_type_body', 'annotation_type_declaration', 'annotation_type_element_declaration', 'assert_statement',
    'block', 'break_statement', 'catch_clause', 'class_body', 'class_declaration', 'compact_constructor_declaration',
    'constant_declaration', 'constructor_body', 'constructor_declaration', 'continue_statement', 'do_statement',
    'enhanced_for_statement', 'enum_body', 'enum_constant', 'enum_declaration', 'expression_statement',
    'field_declaration', 'for_statement', 'if_statement', 'interface_body', 'interface_declaration', 'labeled_statement',
    'lambda_expression', 'local_variable_declaration', 'method_declaration', 'module_declaration', 'record_declaration',
    'return_statement', 'static_initializer', 'switch_block', 'switch_block_statement_group', 'switch_expression',
    'switch_rule', 'synchronized_statement', 'throw_statement', 'try_statement', 'try_with_resources_statement',
    'while_statement', 'yield_statement',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['type_identifier', 'identifier'],
    ['binary_integer_literal', 'integer'], ['decimal_integer_literal', 'integer'], ['hex_integer_literal', 'integer'],
    ['octal_integer_literal', 'integer'], ['decimal_floating_point_literal', 'float'], ['hex_floating_point_literal', 'float'],
    ['character_literal', 'character'], ['string_literal', 'string'], ['true', 'boolean'], ['false', 'boolean'],
    ['null_literal', 'null'],
  ]),
};

export const java: Grammar = {
  language: { id: 'java', label: 'Java', color: '#b07219', extensions: ['.java'], measures: [...measures, 'classes'], syntax: javaSyntax },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  // The grammar ends // comments at LF. Normalizing lone CR preserves the source offsets.
  prepareSource: text => text.replace(/\r(?!\n)/g, '\n'),
  columns: 'codepoints',
  name: node => node.childForFieldName('name')?.text,
  rules: {
    method_declaration: { flow: 'function', requiresBody: true },
    constructor_declaration: { flow: 'function' },
    compact_constructor_declaration: { flow: 'function' },
    lambda_expression: { flow: 'function' },
    class_declaration: { flow: 'class' },
    interface_declaration: { flow: 'class' },
    enum_declaration: { flow: 'class' },
    record_declaration: { flow: 'class' },
    annotation_type_declaration: { flow: 'class' },
    if_statement: { flow: 'if', decision: true },
    for_statement: { flow: 'nest', decision: true },
    enhanced_for_statement: { flow: 'nest', decision: true },
    while_statement: { flow: 'nest', decision: true },
    do_statement: { flow: 'nest', decision: true },
    catch_clause: { flow: 'nest', decision: true },
    ternary_expression: { flow: 'nest', decision: true },
    // The grammar uses switch_expression for both statement and expression forms.
    switch_expression: { flow: 'nest' },
    switch_label: { decision: node => Number(node.firstChild?.type === 'case') },
    break_statement: { exit: 'label' },
    continue_statement: { exit: 'label' },
    return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']),
  comments: new Set(['line_comment', 'block_comment']),
  extras: new Set(),
  logicalTypes: new Set(['binary_expression']),
  logicalOperators: new Set(['&&', '||']),
  logicalCognitive: 'parent',
  singleParameterTypes: new Set(['identifier']),
  parameterSeparators: new Set(['receiver_parameter']),
  moduleDepthLabel: 'Module · Control-flow depth',
  tokens,
};
