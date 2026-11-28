import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

function name(node: Node): string | undefined {
  const simple = node.childForFieldName('name')?.text;
  if (!simple) return undefined;
  const names = [simple];
  // Modules contribute to qualified names without being counted as classes.
  let child = node;
  for (let scope = node.parent; scope; child = scope, scope = scope.parent) {
    if (scope.childForFieldName('body')?.id !== child.id) continue;
    if (scope.type === 'class' || scope.type === 'method' || scope.type === 'singleton_method') break;
    if (scope.type === 'module') {
      const module = scope.childForFieldName('name')?.text;
      if (module) names.push(module);
    }
  }
  return names.reverse().join('.');
}

const tokens: Grammar['tokens'] = {
  candidates: new Set(['method', 'singleton_method', 'lambda', 'class', 'singleton_class', 'module',
    'body_statement', 'block_body', 'do', 'then', 'else', 'ensure', 'assignment', 'operator_assignment',
    'call', 'return', 'begin', 'if', 'unless', 'elsif', 'while', 'until', 'for', 'case', 'case_match',
    'when', 'in_clause', 'rescue', 'conditional', 'if_modifier', 'unless_modifier', 'while_modifier',
    'until_modifier', 'rescue_modifier']),
  kinds: new Map([
    ['identifier', 'identifier'], ['constant', 'constant'], ['instance_variable', 'instance_variable'],
    ['class_variable', 'class_variable'], ['global_variable', 'global_variable'],
    ['integer', 'integer'], ['float', 'float'], ['string_content', 'string_content'],
    ['heredoc_content', 'heredoc_content'], ['simple_symbol', 'simple_symbol'],
    ['true', 'boolean'], ['false', 'boolean'], ['nil', 'nil'],
  ]),
};

export const ruby: Grammar = {
  language: { id: 'ruby', label: 'Ruby', color: '#701516', extensions: ['.rb'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints', name,
  rules: {
    method: { flow: 'function' }, singleton_method: { flow: 'function' }, lambda: { flow: 'function' },
    class: { flow: 'class' }, singleton_class: { flow: 'class' },
    if: { flow: 'if', decision: true }, unless: { flow: 'if', decision: true },
    // An elsif owns the next alternative, just like the initial if.
    elsif: { flow: 'if', decision: true },
    else: { flow: 'else', elseCognitive: node => {
      const parent = node.parent?.type;
      return parent !== 'case' && parent !== 'case_match';
    } },
    while: { flow: 'nest', decision: true }, until: { flow: 'nest', decision: true }, for: { flow: 'nest', decision: true },
    case: { flow: 'nest' }, when: { decision: true },
    case_match: { flow: 'nest' }, in_clause: { decision: true },
    if_guard: { decision: true }, unless_guard: { decision: true },
    rescue: { flow: 'nest', decision: true }, rescue_modifier: { flow: 'nest', decision: true },
    conditional: { flow: 'nest', decision: true },
    if_modifier: { flow: 'nest', decision: true }, unless_modifier: { flow: 'nest', decision: true },
    while_modifier: { flow: 'nest', decision: true }, until_modifier: { flow: 'nest', decision: true },
    return: { exit: 'return' },
  },
  parens: new Set(['parenthesized_statements']), comments: new Set(['comment']),
  extras: new Set(['empty_statement']),
  logicalTypes: new Set(['binary']), logicalOperators: new Set(['&&', '||', 'and', 'or']), logicalCognitive: 'parent',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
