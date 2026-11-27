import type { Node } from 'web-tree-sitter';
import type { Grammar, NodeRule } from './language.js';
import type { SourceLines } from './source-lines.js';

export class Flow {
  cyclomatic = 1;
  cognitive = 0;
  returns = 0;
  depth = 0;
  deepest?: Node;

  block(node: Node, depth: number, chained = false): void {
    this.cognitive += chained ? 1 : 1 + depth;
    if (depth + 1 <= this.depth) return;
    this.depth = depth + 1;
    this.deepest = node;
  }
}

export interface Visit {
  readonly node: Node;
  readonly flow: Flow;
  readonly depth: number;
  readonly parent?: NodeRule['flow'];
  readonly logical?: string;
  readonly chained?: boolean;
}

export type Work = Visit | (() => void);

export class Traversal {
  private readonly pending: Work[] = [];
  constructor(readonly grammar: Grammar, private readonly source: SourceLines) {}

  run(root: Node, module: Flow, visit: (task: Visit) => void): void {
    this.children(root, module, 0);
    while (this.pending.length) {
      const item = this.pending.pop()!;
      if (typeof item === 'function') item();
      else visit(item);
    }
  }

  next(items: readonly Work[]): void {
    for (let index = items.length - 1; index >= 0; index--) this.pending.push(items[index]!);
  }

  named(node: Node): Node[] {
    return node.namedChildren.filter(child => !this.ignored(child.type));
  }

  ignored(type: string): boolean {
    return this.grammar.comments.has(type) || this.grammar.extras.has(type);
  }

  children(node: Node, flow: Flow, depth: number, parent?: NodeRule['flow'], logical?: string): void {
    const ordered = this.grammar.rules[node.type]?.order;
    const names = this.named(node);
    const children = ordered ? ordered.flatMap(index => names[index] ?? []) : names;
    if (node.type === this.grammar.requireNonemptyBlock && children.length === 0) {
      throw new SyntaxError('Expected a statement in the block at ' + this.source.location(node.startIndex, this.grammar.columns));
    }
    this.next(children.map(child => {
      if (this.grammar.rules[child.type]?.flow !== 'filter') return { node: child, flow, depth, parent, logical };
      const at = depth++;
      return () => {
        flow.block(this.condition(child), at);
        this.children(child, flow, at + 1);
      };
    }));
  }

  condition(node: Node): Node {
    let expression = this.named(node)[0] ?? node;
    while (this.grammar.parens.has(expression.type)) {
      const child = this.named(expression)[0];
      if (!child) break;
      expression = child;
    }
    return expression;
  }
}
