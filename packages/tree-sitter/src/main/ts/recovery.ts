import type { Node } from 'web-tree-sitter';
import type { Grammar } from './language.js';
import { lowerBound } from './source-lines.js';
import type { Span } from './source-lines.js';

export interface RecoveredScope {
  readonly node: Node;
  readonly parents: readonly string[];
}

/** Distinguish missing tokens from error intervals because a missing token can sit on a node boundary. */
export function damagedSyntax(root: Node): (span: Span) => boolean {
  const intervals: Span[] = [];
  const missing: number[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const children = node.children.filter(child => child.hasError || child.isError || child.isMissing);
    if (node.isMissing) missing.push(node.startIndex);
    else if (node.isError || !children.length) intervals.push({ start: node.startIndex, end: node.endIndex });
    pending.push(...children);
  }

  intervals.sort((left, right) => left.start - right.start);
  missing.sort((left, right) => left - right);
  const starts = intervals.map(interval => interval.start);
  let lastEnd = 0;
  const ends = intervals.map(interval => lastEnd = Math.max(lastEnd, interval.end));
  return ({ start, end }) => {
    const previous = lowerBound(starts, end) - 1;
    const point = missing[lowerBound(missing, start)];
    // An error can swallow a modifier immediately before the declaration.
    return (ends[previous] ?? -1) >= start || (point !== undefined && point <= end);
  };
}

function isDeclaration(node: Node, grammar: Grammar): boolean {
  const rule = grammar.rules[node.type];
  if (rule?.flow !== 'function' && rule?.flow !== 'class') return false;
  return !rule.requiresBody || (rule.body?.(node).length ?? Number(node.childForFieldName('body') !== null)) > 0;
}

/** Select maximal intact declarations. Their nested declarations are measured by the normal structure traversal. */
export function recoveredScopes(root: Node, grammar: Grammar, damaged: (span: Span) => boolean) {
  const scopes: RecoveredScope[] = [];
  const pending: RecoveredScope[] = [{ node: root, parents: [] }];
  let omitted = 0;
  while (pending.length) {
    const scope = pending.pop()!;
    const { node, parents } = scope;
    let context = parents;
    if (isDeclaration(node, grammar)) {
      if (!damaged({ start: node.startIndex, end: node.endIndex })) {
        scopes.push(scope);
        continue;
      }
      omitted++;
      const name = grammar.name(node);
      if (name) context = [...parents, name];
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index]!, parents: context });
  }
  return { scopes, omitted };
}
