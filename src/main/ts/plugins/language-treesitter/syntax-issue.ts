import type { Node } from 'web-tree-sitter';
import type { Grammar } from './language.js';

export function firstSyntaxIssue(node: Node, grammar: Grammar): { offset: number; reason: string } {
  while (!node.isError && !node.isMissing) {
    const child = node.children.find(child => child.hasError);
    if (!child) break;
    node = child;
  }
  if (node.isMissing) return missing(node);
  if (node.childCount === 1 && node.firstChild?.type === 'string_start') {
    return { offset: node.startIndex, reason: 'Unterminated string' };
  }
  return errorToken(node, grammar);
}

function missing(node: Node) {
  return { offset: node.startIndex, reason: 'Expected ' + JSON.stringify(node.type) };
}

function errorToken(error: Node, grammar: Grammar) {
  let previous: Node | undefined;
  for (const node of errorLeaves(error)) {
    if (node.isMissing) return missing(node);
    if (node.isError) return unexpected(node.startIndex);
    if (node.isExtra) continue;
    if (!node.parseState) return expectedAfter(previous, grammar) ?? unexpected(node.startIndex);
    if (!symbols(node, node.parseState).includes(node.grammarType)) return unexpectedAfter(error, previous, node, grammar);
    previous = node;
  }
  return expectedAfter(previous, grammar) ?? missingHeaderColon(error, previous, grammar)
    ?? unexpected(previous?.endIndex ?? error.startIndex);
}

function unexpectedAfter(error: Node, previous: Node | undefined, node: Node, grammar: Grammar) {
  const nextLine = previous && node.startPosition.row > previous.endPosition.row;
  return (nextLine ? missingHeaderColon(error, previous, grammar) : undefined) ?? unexpected(node.startIndex);
}

function missingHeaderColon(error: Node, previous: Node | undefined, grammar: Grammar) {
  if (grammar.language.id !== 'python' || !previous || error.firstChild?.type !== 'if') return undefined;
  if (!symbols(previous, previous.nextParseState).includes(':')) return undefined;
  return { offset: previous.endIndex, reason: 'Expected ":"' };
}

function* errorLeaves(root: Node) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (!node.childCount || node.isMissing) yield node;
    else for (const child of node.children.toReversed()) pending.push(child);
  }
}

function expectedAfter(previous: Node | undefined, grammar: Grammar) {
  if (!previous?.nextParseState) return undefined;
  const expected = symbols(previous, previous.nextParseState)
    .filter(name => !grammar.comments.has(name) && !grammar.extras.has(name));
  if (!expected.length || expected.length > 2 || !expected.every(name => /^[^\w\s]+$/u.test(name))) return undefined;
  return { offset: previous.endIndex, reason: 'Expected ' + expected.map(name => JSON.stringify(name)).join(' or ') };
}

function unexpected(offset: number) {
  return { offset, reason: 'Unexpected syntax' };
}

function symbols(node: Node, state: number): readonly string[] {
  const iterator = node.tree.language.lookaheadIterator(state);
  if (!iterator) return [];
  try {
    return [...iterator];
  } finally {
    iterator.delete();
  }
}
