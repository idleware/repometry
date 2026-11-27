import type { Node } from 'web-tree-sitter';
import type { Grammar } from '../language.js';
import { measures } from '../language.js';
import { goSyntax } from './go-syntax.js';

function receiver(type: Node | null | undefined): string | undefined {
  let pointers = 0;
  while (type) {
    switch (type.type) {
      case 'type_identifier': return '(*'.repeat(pointers) + type.text + ')'.repeat(pointers);
      case 'pointer_type': pointers++; type = type.namedChild(0); break;
      case 'generic_type': type = type.childForFieldName('type'); break;
      case 'parenthesized_type': type = type.namedChild(0); break;
      default: return undefined;
    }
  }
}

function name(node: Node) {
  const simple = node.childForFieldName('name')?.text;
  const parameters = node.childForFieldName('receiver');
  const type = receiver(parameters?.namedChild(0)?.childForFieldName('type'));
  return type && simple ? `${type}.${simple}` : simple;
}

// Start with go/scanner tokens. Omit comments, whitespace and the semicolons whose literal is a newline.
// Preserve explicit semicolons, keywords and operators. Strip CR inside raw strings and retain the spelling of _.
// The similar kinds are identifier (including predeclared names), string (raw or interpreted), rune,
// integer, float and imaginary. Files under 12 code lines contribute no clone tokens.
// Each token is its UTF-16 code-unit length, a colon and the spelling. Similar fingerprints use !kind: for those kinds.
const tokens: Grammar['tokens'] = {
  candidates: new Set(['assignment_statement', 'block', 'break_statement', 'const_declaration', 'continue_statement',
    'dec_statement', 'defer_statement', 'expression_case', 'expression_statement', 'expression_switch_statement',
    'fallthrough_statement', 'for_statement', 'func_literal', 'function_declaration', 'go_statement', 'goto_statement',
    'if_statement', 'inc_statement', 'labeled_statement', 'method_declaration', 'receive_statement',
    'return_statement', 'select_statement', 'send_statement', 'short_var_declaration', 'type_case', 'communication_case',
    'default_case', 'type_declaration', 'type_switch_statement', 'var_declaration']),
  kinds: new Map([
    ...['identifier', 'field_identifier', 'type_identifier', 'package_identifier', 'label_name', 'true', 'false', 'nil', 'iota']
      .map(kind => [kind, 'identifier'] as const),
    ['int_literal', 'integer'], ['float_literal', 'float'], ['imaginary_literal', 'imaginary'],
    ['rune_literal', 'rune'], ['interpreted_string_literal', 'string'], ['raw_string_literal', 'string'],
  ]),
  normalize: (type, text, kind) => [type === 'raw_string_literal' ? text.replaceAll('\r', '') : text, text === '_' ? undefined : kind],
};

export const go: Grammar = {
  language: { id: 'go', label: 'Go', color: '#00add8', extensions: ['.go'], measures, syntax: goSyntax },
  asset: new URL('../../../../resources/languages/go/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text.endsWith('\n') ? text : text + '\n',
  lineBreaks: /\r\n|[\n\r\u2028\u2029]/g,
  columns: 'bytes', name,
  rules: {
    function_declaration: { flow: 'function' }, method_declaration: { flow: 'function' }, func_literal: { flow: 'function' },
    if_statement: { flow: 'if', decision: true }, for_statement: { flow: 'nest', decision: true },
    expression_switch_statement: { flow: 'nest' }, type_switch_statement: { flow: 'nest' }, select_statement: { flow: 'nest' },
    expression_case: { decision: true }, type_case: { decision: true }, communication_case: { decision: true },
    break_statement: { exit: 'label' }, continue_statement: { exit: 'label' }, goto_statement: { exit: 'label' },
    return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments: new Set(['comment']), extras: new Set(),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['&&', '||']), logicalCognitive: 'parent',
  parameterNames: 'name', requireFirst: 'package_clause', reportFileRange: true,
  moduleDepthLabel: 'Module control-flow depth', tokens,
};
