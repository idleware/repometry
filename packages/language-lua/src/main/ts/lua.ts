import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

function name(node: Node): string | undefined {
  const declared = node.childForFieldName('name');
  if (!declared || declared.type === 'identifier') return declared?.text;
  const parts = declared.descendantsOfType('identifier').map(part => part.text);
  const method = declared.type === 'method_index_expression' ? parts.pop() : undefined;
  return parts.join('.') + (method === undefined ? '' : ':' + method);
}

function parameterCount(node: Node): number {
  let count = 0;
  for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
    // Lua 5.5 can name the final vararg. It is still one parameter.
    if (parameter.type === 'vararg_expression') return count + 1;
    if (parameter.type === 'identifier') count++;
  }
  return count;
}

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'assignment_statement', 'block', 'break_statement', 'do_statement', 'else_statement', 'elseif_statement',
    'field', 'for_statement', 'function_call', 'function_declaration', 'function_definition', 'goto_statement',
    'if_statement', 'implicit_variable_declaration', 'repeat_statement', 'return_statement',
    'table_constructor', 'variable_declaration', 'while_statement',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['number', 'number'], ['string', 'string'],
    ['true', 'boolean'], ['false', 'boolean'], ['nil', 'nil'],
  ]),
};

export const lua: Grammar = {
  language: {
    id: 'lua', label: 'Lua', color: '#000080', extensions: ['.lua'], measures,
    // Long brackets may use any number of equals signs; keep the viewer's forms line-scoped.
    syntax: {
      lineComments: ['--'], strings: [{ quote: "'" }, { quote: '"' }],
      keywords: ['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
        'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'],
    },
  },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints', name,
  rules: {
    function_declaration: { flow: 'function', parameters: parameterCount },
    function_definition: { flow: 'function', parameters: parameterCount },
    if_statement: { flow: 'if', decision: true }, elseif_statement: { flow: 'elif', decision: true },
    else_statement: { flow: 'else' },
    for_statement: { flow: 'nest', decision: true }, while_statement: { flow: 'nest', decision: true },
    repeat_statement: { flow: 'nest', decision: true },
    goto_statement: { exit: 'label' }, return_statement: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments: new Set(['comment', 'hash_bang_line']),
  extras: new Set(),
  logicalTypes: new Set(['binary_expression']), logicalOperators: new Set(['and', 'or']), logicalCognitive: 'parent',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
