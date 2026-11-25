import { isClass, isFunction, isIdentifier, isMemberExpression, isObjectExpression, isStringLiteral } from '@babel/types';
import type { Node } from '@babel/types';
import { children } from './function-facts.js';

/** A function's qualified name, absent when the function has none, and the anchor its observations carry. */
export interface FunctionNaming {
  readonly name?: string;
  readonly anchor: string;
}

/**
 * Names every function by the classes, object literals and functions around it, joined with dots, as in
 * `commands.review.run`. A function without a name of its own is `(anonymous)` in the anchors of it and its contents.
 */
export function qualifiedNames(ast: Node): ReadonlyMap<Node, FunctionNaming> {
  const names = new Map<Node, FunctionNaming>();
  const scope: string[] = [];
  visit(ast, undefined);
  return names;

  function visit(node: Node, parent: Node | undefined): void {
    const own = segment(node, parent);
    const opens = own !== undefined || isFunction(node);
    if (isFunction(node)) {
      const anchor = [...scope, own ?? '(anonymous)'].join('.');
      names.set(node, own === undefined ? { anchor } : { name: anchor, anchor });
    }
    if (opens) scope.push(own ?? '(anonymous)');
    for (const child of children(node)) visit(child, node);
    if (opens) scope.pop();
  }
}

function segment(node: Node, parent: Node | undefined): string | undefined {
  if (isFunction(node)) return ('id' in node && node.id ? node.id.name : 'key' in node ? keyName(node.key) : undefined)
    ?? binding(node, parent);
  if (isClass(node)) return node.id?.name ?? binding(node, parent);
  return isObjectExpression(node) ? binding(node, parent) : undefined;
}

/** The name a value takes from the declaration, property or assignment that holds it. */
function binding(node: Node, parent: Node | undefined): string | undefined {
  switch (parent?.type) {
    case 'VariableDeclarator':
      return parent.init === node && isIdentifier(parent.id) ? parent.id.name : undefined;
    case 'ObjectProperty':
    case 'ClassProperty':
    case 'ClassPrivateProperty':
      return parent.value === node ? keyName(parent.key) : undefined;
    case 'AssignmentExpression': {
      if (parent.right !== node) return undefined;
      const target = parent.left;
      if (isIdentifier(target)) return target.name;
      return isMemberExpression(target) && !target.computed && isIdentifier(target.property) ? target.property.name : undefined;
    }
    default:
      return undefined;
  }
}

function keyName(key: Node): string | undefined {
  if (isIdentifier(key)) return key.name;
  if (isStringLiteral(key)) return key.value;
  return key.type === 'PrivateName' ? `#${key.id.name}` : undefined;
}
