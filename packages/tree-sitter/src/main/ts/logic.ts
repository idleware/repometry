import type { Node } from 'web-tree-sitter';
import type { Grammar } from './language.js';

export function logicalOperator(node: Node, grammar: Grammar): string | undefined {
  if (!grammar.logicalTypes.has(node.type)) return undefined;
  const operator = node.childForFieldName('operator') ?? node.children.find(child => !child.isNamed);
  if (!operator) return undefined;
  const spelling = grammar.logicalOperatorSpelling ? operator.text : operator.type;
  return grammar.logicalOperators.has(spelling) ? spelling : undefined;
}

export function expressionOperators(root: Node, grammar: Grammar): string[] {
  const sequence: string[] = [];
  const pending: (Node | string)[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === 'string') sequence.push(node);
    else for (const item of operatorWork(node, grammar)) pending.push(item);
  }
  return sequence;
}

function operatorWork(node: Node, grammar: Grammar): (Node | string)[] {
  if (grammar.parens.has(node.type)) return node.namedChildren.reverse();
  const operator = logicalOperator(node, grammar);
  if (operator === undefined) return [];
  const children = node.namedChildren.filter(child => !grammar.comments.has(child.type) && !grammar.extras.has(child.type));
  const first = node.childForFieldName('left') ?? children[0];
  const second = node.childForFieldName('right') ?? children[1];
  return [...(second ? [second] : []), operator, ...(first ? [first] : [])];
}
