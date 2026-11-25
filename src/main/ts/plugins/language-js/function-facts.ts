import { VISITOR_KEYS, isBlockStatement, isFunction } from '@babel/types';
import type { Function as BabelFunction, Node } from '@babel/types';
import type { FunctionComplexity } from '../../core/model/code-structure.js';
import type { FunctionNaming } from './qualified-names.js';

const decisionNodes = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause', 'LogicalExpression']);

export function functionFacts(ast: Node, names: ReadonlyMap<Node, FunctionNaming>) {
  let functions = 0;
  const bodyRanges: [number, number][] = [];
  walk(ast, node => {
    if (!isFunction(node) || !node.body) return;
    functions++;
    const range = bodyRange(node.body);
    if (range) bodyRanges.push(range);
  });
  const cyclomaticFunctions: FunctionComplexity[] = [];
  visit(ast, undefined);
  return { functions, cyclomaticFunctions, functionBodies: mergeBodyRanges(bodyRanges) };

  function visit(node: Node, frame: { value: number } | undefined): void {
    if (isFunction(node) && node.body) {
      const own = { value: 1 };
      // The body defines this method's decision scope. Nested functions get separate frames.
      visit(node.body, own);
      for (const parameter of node.params) visit(parameter, undefined);
      const start = node.loc?.start;
      cyclomaticFunctions.push({ line: start?.line,
        column: start === undefined ? undefined : start.column + 1, name: names.get(node)?.name, value: own.value });
      return;
    }
    if (frame && (decisionNodes.has(node.type) || (node.type === 'SwitchCase' && node.test !== null))) frame.value++;
    for (const child of children(node)) visit(child, frame);
  }
}

function bodyRange(body: NonNullable<BabelFunction['body']>): [number, number] | undefined {
  if (!isBlockStatement(body)) return body.loc ? [body.loc.start.line, body.loc.end.line] : undefined;
  const first = body.directives[0] ?? body.body[0];
  const last = body.body.at(-1) ?? body.directives.at(-1);
  if (first?.loc && last?.loc) return [first.loc.start.line, last.loc.end.line];
}

function mergeBodyRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [first, last] of ranges.sort(([left], [right]) => left - right)) {
    const previous = merged.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return merged;
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
