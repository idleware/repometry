import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];
type Rule = Grammar['rules'][string];
const functions = new Set(['def', 'defp', 'defmacro', 'defmacrop']);
const modules = new Set(['defmodule', 'defprotocol', 'defimpl']);
const comments = new Set(['comment']);

function named(node?: Node | null): readonly Node[] {
  return node?.namedChildren.filter(child => !comments.has(child.type)) ?? [];
}

function child(node: Node, type: string): Node | undefined {
  return node.namedChildren.find(member => member.type === type);
}

function target(node?: Node | null): string | undefined {
  const identifier = node?.childForFieldName('target');
  return identifier?.type === 'identifier' ? identifier.text : undefined;
}

function operator(node?: Node | null): string | undefined {
  return node?.childForFieldName('operator')?.type;
}

function unguard(node?: Node | null): Node | null | undefined {
  while (node && operator(node) === 'when') node = node.childForFieldName('left');
  return node;
}

function argumentNodes(node: Node): readonly Node[] {
  return named(child(node, 'arguments'));
}

function keyword(node: Node): string | undefined {
  return node.childForFieldName('key')?.text.trimEnd();
}

function pair(node: Node, key: string): Node | undefined {
  const list = argumentNodes(node).find(item => item.type === 'keywords');
  return named(list).find(item => keyword(item) === key);
}

function callBody(node: Node): readonly Node[] {
  const block = child(node, 'do_block');
  const args = child(node, 'arguments');
  // Keep the clause head with the body so its guard belongs to the clause.
  return block ? [...(args ? [args] : []), block] : args && pair(node, 'do:') ? [args] : [];
}

function name(node: Node): string | undefined {
  if (node.type !== 'call') return undefined;
  const first = argumentNodes(node)[0];
  if (modules.has(target(node) ?? '')) {
    if (first?.type !== 'alias' && first?.type !== 'atom') return undefined;
    const type = pair(node, 'for:')?.childForFieldName('value');
    return target(node) === 'defimpl' && type?.type === 'alias' ? `${first.text}.${type.text}` : first.text;
  }
  const head = unguard(first);
  return head?.type === 'identifier' ? head.text : target(head) ?? head?.childForFieldName('operator')?.text;
}

function formalParameters(node: Node): number {
  const head = unguard(argumentNodes(node)[0]);
  if (head?.type === 'binary_operator') return 2;
  if (head?.type === 'unary_operator') return 1;
  return head ? argumentNodes(head).length : 0;
}

function captureRule(node: Node): Rule | undefined {
  if (operator(node) !== '&') return undefined;
  const operand = captureOperand(node);
  if (!operand || operand.type === 'integer') return undefined;
  const pending = [operand];
  let arity = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (operator(item) === '&') {
      const index = captureOperand(item);
      const value = index?.type === 'integer' ? Number(index.text) : 0;
      if (Number.isSafeInteger(value)) arity = Math.max(arity, value);
    } else if (item.type !== 'anonymous_function') {
      for (const child of named(item)) pending.push(child);
    }
  }
  return arity ? { flow: 'function', body: named, parameters: () => arity } : undefined;
}

function captureOperand(node: Node): Node | undefined {
  return node.childrenForFieldName('operand').find(child => child.isNamed);
}

function alternate(node: Node): Node | null {
  const body = child(node, 'do_block');
  return (body && child(body, 'else_block')) ?? pair(node, 'else:') ?? null;
}

function conditionalChildren(node: Node): readonly Node[] {
  return named(node).flatMap(member => {
    if (member.type === 'do_block') return named(member);
    if (member.type !== 'arguments') return [member];
    return named(member).flatMap(argument => argument.type === 'keywords' ? named(argument) : [argument]);
  });
}

const conditional: Rule = { flow: 'if', decision: true, alternative: alternate, conditionalChildren };
const routine: Rule = { flow: 'function', body: callBody, requiresBody: true, parameters: formalParameters };
const module: Rule = { flow: 'class', body: callBody, requiresBody: true };
const nested: Rule = { flow: 'nest' };
const comprehension: Rule = { flow: 'nest', decision: node => argumentNodes(node).filter(item => item.type !== 'keywords').length };
const withChain: Rule = { flow: 'nest', decision: node => argumentNodes(node).filter(item => operator(item) === '<-').length };

function callRule(node: Node): Rule | undefined {
  const word = target(node);
  if (!word) return undefined;
  if (functions.has(word)) return routine;
  if (modules.has(word)) return module;
  switch (word) {
    case 'if': case 'unless': return conditional;
    case 'case': case 'cond': case 'receive': return nested;
    case 'for': return comprehension;
    case 'with': return withChain;
    default: return undefined;
  }
}

function patterns(node: Node): readonly Node[] {
  return named(unguard(node.childForFieldName('left')));
}

const armContainers = new Set(['arguments', 'keywords', 'pair', 'block', 'do_block', 'else_block', 'after_block', 'rescue_block', 'catch_block']);

function armRule(node: Node): Rule | undefined {
  let part: string | undefined;
  let context = node.parent;
  while (context && armContainers.has(context.type)) {
    part ??= context.type === 'pair' ? keyword(context) : blockPart(context.type);
    context = context.parent;
  }
  const owner = target(context);
  if (owner === 'cond') return conditionArm;
  if (owner === 'receive' && part === 'after:') return timeoutArm;
  if (owner === 'try' && (part === 'rescue:' || part === 'catch:')) return handler;
  if (context?.type === 'anonymous_function' || owner === 'case' || owner === 'receive' || owner === 'with' || owner === 'try') return matchArm;
}

function blockPart(type: string): string | undefined {
  return type !== 'do_block' && type.endsWith('_block') ? type.slice(0, -6) + ':' : undefined;
}

const handler: Rule = { flow: 'nest', decision: true };
const conditionArm: Rule = { decision: node => Number(patterns(node)[0]?.text !== 'true') };
const timeoutArm: Rule = { decision: true };
const matchArm: Rule = { decision: node => Number(patterns(node).some(item => item.type !== 'identifier')) };
const guard: Rule = { decision: node => Number(operator(node) === 'when') };
const elseRule: Rule = { flow: 'else' };

export const elixir: Grammar = {
  language: { id: 'elixir', label: 'Elixir', color: '#6e4a7e', extensions: ['.ex', '.exs'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints', name,
  rules: {
    call: { select: callRule },
    anonymous_function: { flow: 'function', body: named, parameters: node => {
      const arm = child(node, 'stab_clause');
      return arm ? patterns(arm).length : 0;
    } },
    unary_operator: { select: captureRule },
    stab_clause: { select: armRule },
    binary_operator: guard,
    else_block: { select: node => target(node.parent?.parent) === 'if' || target(node.parent?.parent) === 'unless' ? elseRule : undefined },
    pair: { select: node => keyword(node) === 'else:' ? elsePair(node) : undefined },
  },
  parens: new Set(['block']), comments, extras: new Set(),
  logicalTypes: new Set(['binary_operator']), logicalOperators: new Set(['&&', '||', 'and', 'or']), logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth',
  tokens: {
    candidates: new Set(['call', 'anonymous_function', 'block', 'do_block', 'else_block', 'body', 'stab_clause',
      'after_block', 'rescue_block', 'catch_block', 'binary_operator', 'list', 'tuple', 'map']),
    kinds: new Map([['identifier', 'identifier'], ['alias', 'alias'], ['atom', 'atom'], ['quoted_atom', 'atom'],
      ['integer', 'integer'], ['float', 'float'], ['char', 'char'], ['string', 'string'], ['charlist', 'charlist'],
      ['boolean', 'boolean'], ['nil', 'nil']]),
  },
};

function elsePair(node: Node): Rule | undefined {
  const owner = target(node.parent?.parent?.parent);
  return owner === 'if' || owner === 'unless' ? elseRule : undefined;
}
