import type { Node } from 'web-tree-sitter';
import type { StructuralCheck } from '@repometry/core/internal/model/code-structure.js';
import type { Flow, Traversal, Visit, Work } from './flow.js';
import type { NodeRule } from './language.js';
import { expressionOperators, logicalOperator } from './logic.js';

type Observe = (rule: StructuralCheck, value: number, label: string, node: Node) => void;

export class Control {
  constructor(private readonly walk: Traversal, private readonly observe: Observe) {}

  visit(task: Visit, rule?: NodeRule): void {
    const { node, flow, depth, parent, logical } = task;
    const kind = rule?.flow;
    const operation = logicalOperator(node, this.walk.grammar);
    this.decisions(node, flow, rule);
    if (operation !== undefined) this.logical(node, flow, operation, logical);
    switch (kind) {
      case 'if': return this.conditional(node, flow, depth, task.chained);
      case 'elif': flow.cognitive++; break;
      case 'else':
        if (rule?.elseCognitive?.(node) !== false) flow.cognitive++;
        return this.walk.children(node, flow, depth + Number(parent !== 'nest'));
      case 'sequence': return this.sequence(node, flow, depth);
      case 'nest': flow.block(node, depth); break;
    }
    const carried = this.walk.grammar.parens.has(node.type) ? logical : operation;
    this.walk.children(node, flow, depth + Number(kind === 'nest'), kind, carried);
  }

  private decisions(node: Node, flow: Flow, rule: NodeRule | undefined): void {
    if (rule?.decision) flow.cyclomatic += rule.decision === true ? 1 : rule.decision(node);
    if (rule?.exit === 'return') flow.returns++;
    if (rule?.exit === 'label' && this.walk.named(node).length) flow.cognitive++;
  }

  private logical(node: Node, flow: Flow, operator: string, parent: string | undefined): void {
    flow.cyclomatic++;
    const parentMode = this.walk.grammar.logicalCognitive === 'parent';
    if (parentMode && parent !== operator) flow.cognitive++;
    if (parent !== undefined) return;
    const sequence = expressionOperators(node, this.walk.grammar);
    if (!parentMode) flow.cognitive += sequence.filter((item, index) => item !== sequence[index - 1]).length;
    this.observe('boolean-logic', sequence.length, 'Logical operators in one expression', node);
  }

  private conditional(node: Node, flow: Flow, depth: number, chained?: boolean): void {
    flow.block(node, depth, chained);
    const work: Work[] = [];
    const rule = this.walk.grammar.rules[node.type];
    const alternate = rule?.alternative?.(node);
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index)!;
      const explicitAlternative = child.id === alternate?.id;
      if ((!child.isNamed && !explicitAlternative) || this.walk.ignored(child.type)) continue;
      const branches = rule?.alternativeBranches?.(child);
      if (branches) {
        work.push(...branches.map(branch => this.alternative(branch, flow, depth)));
        continue;
      }
      const alternative = explicitAlternative || node.fieldNameForChild(index) === 'alternative';
      work.push(alternative ? this.alternative(child, flow, depth) : { node: child, flow, depth: depth + 1 });
    }
    this.walk.next(work);
  }

  private alternative(node: Node, flow: Flow, depth: number): Work {
    const rule = this.walk.grammar.rules[node.type];
    const chained = rule?.chainedAlternative ? this.chainedChild(node) : undefined;
    if (chained) return { node: chained, flow, depth, chained: true };
    switch (rule?.flow) {
      case 'if': return { node, flow, depth, chained: true };
      case 'elif': return { node, flow, depth: depth + 1 };
      case 'else': return { node, flow, depth: depth + 1, parent: 'nest' };
      default: return () => {
        flow.cognitive++;
        this.walk.next([{ node, flow, depth: depth + 1 }]);
      };
    }
  }

  private chainedChild(node: Node): Node | undefined {
    const [child, sibling] = this.walk.named(node);
    return child && sibling === undefined && this.walk.grammar.rules[child.type]?.flow === 'if' ? child : undefined;
  }

  private sequence(node: Node, flow: Flow, depth: number): void {
    const work: Work[] = [];
    const values: Node[] = [];
    for (const child of this.walk.named(node)) {
      const kind = this.walk.grammar.rules[child.type]?.flow;
      if (kind === 'clause' || kind === 'filter') {
        const at = depth++;
        work.push(() => {
          flow.cyclomatic++;
          const position = kind === 'filter' ? this.walk.condition(child) : node;
          flow.block(position, at);
          this.walk.children(child, flow, at + 1);
        });
      } else values.push(child);
    }
    this.walk.next([...work, ...values.map(value => ({ node: value, flow, depth }))]);
  }
}
