import { isClass, isFunction, isIdentifier, isVariableDeclarator } from '@babel/types';
import type { Node } from '@babel/types';
import type { FunctionComplexity, StructuralCheck, StructuralObservation } from '../../core/model/code-structure.js';
import { children, functionName } from './function-facts.js';

const complexityBlocks = new Set<string>([
  'IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'CatchClause', 'SwitchStatement',
]);

interface Frame {
  cognitive: number;
  returns: number;
  nestedRange?: Node;
  maxNesting: number;
}

export function structuralObservations(ast: Node) {
  const observations: StructuralObservation[] = [];
  const cognitiveFunctions: FunctionComplexity[] = [];
  let cognitive = 0;
  let classes = 0;
  const topLevel: Frame = { cognitive: 0, returns: 0, maxNesting: 0 };
  visit(ast, topLevel, 0);
  if (topLevel.nestedRange !== undefined) observe('nested-control-flow', topLevel.maxNesting, 'Module control-flow depth', topLevel.nestedRange);
  cognitive += topLevel.cognitive;
  observe('file-complexity', cognitive, 'File cognitive complexity');
  return { observations, cognitiveFunctions, cognitiveComplexity: cognitive, classes };

  function visit(node: Node, frame: Frame, depth: number, parent?: Node): void {
    if (isClass(node)) classes++;
    if (isFunction(node) && node.body) {
      const own: Frame = { cognitive: 0, returns: 0, maxNesting: 0 };
      visit(node.body, own, 0, node);
      for (const parameter of node.params) visit(parameter, own, 0, node);
      const name = isVariableDeclarator(parent) && isIdentifier(parent.id) ? parent.id.name : functionName(node);
      const start = node.loc?.start;
      cognitiveFunctions.push({ line: start?.line,
        column: start === undefined ? undefined : start.column + 1, name, value: own.cognitive });
      const label = name ?? '(anonymous)';
      cognitive += own.cognitive;
      observe('function-parameters', node.params.length, `${label} · Parameters`, node);
      observe('return-statements', own.returns, `${label} · Return statements`, node);
      observe('function-complexity', own.cognitive, `${label} · Cognitive complexity`, node);
      if (own.nestedRange !== undefined) observe('nested-control-flow', own.maxNesting, `${label} · Control-flow depth`, own.nestedRange);
      return;
    }
    if (node.type === 'ReturnStatement') frame.returns++;
    if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && node.label) frame.cognitive++;
    if (node.type === 'LogicalExpression') {
      if (parent?.type !== 'LogicalExpression' || parent.operator !== node.operator) frame.cognitive++;
      if (parent?.type !== 'LogicalExpression') observe('boolean-logic', countLogicalOperators(node), 'Logical operators in one expression', node);
    }

    const block = complexityBlocks.has(node.type);
    const chained = node.type === 'IfStatement' && parent?.type === 'IfStatement' && parent.alternate === node;
    if (block) {
      frame.cognitive += chained ? 1 : 1 + depth;
      if (depth + 1 > frame.maxNesting) {
        frame.maxNesting = depth + 1;
        frame.nestedRange = node;
      }
    }
    for (const child of children(node)) {
      if (node.type === 'IfStatement' && child === node.alternate) {
        if (child.type === 'IfStatement') visit(child, frame, depth, node);
        else {
          frame.cognitive++;
          visit(child, frame, depth + 1, node);
        }
        continue;
      }
      visit(child, frame, depth + Number(block || node.type === 'TryStatement'), node);
    }
  }

  function observe(rule: StructuralCheck, value: number, label: string, location?: Node): void {
    observations.push({ rule, value, label, line: location?.loc?.start.line, endLine: location?.loc?.end.line });
  }
}

function countLogicalOperators(node: Node): number {
  if (node.type !== 'LogicalExpression') return 0;
  return 1 + countLogicalOperators(node.left) + countLogicalOperators(node.right);
}
