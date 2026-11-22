import { VISITOR_KEYS, isFunction, isIdentifier, isStringLiteral } from '@babel/types';
import type { Function as BabelFunction, Node } from '@babel/types';
import type { FunctionComplexity } from '../../core/model/code-structure.js';

const decisionNodes = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause', 'LogicalExpression']);

export function functionFacts(ast: Node) {
  let functions = 0;
  walk(ast, node => { if (isFunction(node) && node.body) functions++; });
  const cyclomaticFunctions: FunctionComplexity[] = [];
  visit(ast, undefined);
  return { functions, cyclomaticFunctions };

  function visit(node: Node, frame: { value: number } | undefined): void {
    if (isFunction(node) && node.body) {
      const own = { value: 1 };
      // The body defines this method's decision scope. Nested functions get separate frames.
      visit(node.body, own);
      for (const parameter of node.params) visit(parameter, undefined);
      const start = node.loc?.start;
      cyclomaticFunctions.push({ line: start?.line,
        column: start === undefined ? undefined : start.column + 1, name: functionName(node), value: own.value });
      return;
    }
    if (frame && (decisionNodes.has(node.type) || (node.type === 'SwitchCase' && node.test !== null))) frame.value++;
    for (const child of children(node)) visit(child, frame);
  }
}

export function* children(node: Node): Iterable<Node> {
  const properties = node as unknown as Record<string, Node | readonly Node[] | null | undefined>;
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value = properties[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) yield child;
    } else if (value && 'type' in value) {
      yield value;
    }
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

export function functionName(node: BabelFunction): string {
  if ('id' in node && node.id && isIdentifier(node.id)) return node.id.name;
  if ('key' in node) {
    if (isIdentifier(node.key)) return node.key.name;
    if (isStringLiteral(node.key)) return node.key.value;
    if (node.key.type === 'PrivateName') return `#${node.key.id.name}`;
  }
  return '(anonymous)';
}
