import type { Node } from 'web-tree-sitter';
import type { FunctionComplexity, StructuralCheck, StructuralObservation } from '@repometry/core/internal/model/code-structure.js';
import { Control } from './control.js';
import { Flow, Traversal } from './flow.js';
import type { Visit } from './flow.js';
import type { Grammar } from './language.js';
import { lowerBound } from './source-lines.js';
import type { SourceLines } from './source-lines.js';

export class Structure {
  private readonly cyclomaticFunctions: FunctionComplexity[] = [];
  private readonly cognitiveFunctions: FunctionComplexity[] = [];
  private readonly observations: StructuralObservation[] = [];
  private readonly names: string[] = [];
  private readonly anchors: string[] = [];
  private readonly walk: Traversal;
  private readonly control: Control;
  private classes = 0;
  private cognitive = 0;

  constructor(private readonly grammar: Grammar, private readonly lines: SourceLines, private readonly codeLines: readonly number[]) {
    this.walk = new Traversal(grammar, lines);
    this.control = new Control(this.walk, this.observe.bind(this));
  }

  measure(root: Node) {
    const module = new Flow();
    this.walk.run(root, module, task => this.visit(task));
    this.finish(module, this.grammar.moduleDepthLabel);
    const position = this.grammar.reportFileRange ? { line: 1, endLine: this.lines.count } : {};
    this.observations.push({ rule: 'file-complexity', value: this.cognitive, label: 'File cognitive complexity', ...position });

    const byPosition = (left: FunctionComplexity, right: FunctionComplexity) =>
      left.line! - right.line! || left.column! - right.column!;
    this.cyclomaticFunctions.sort(byPosition);
    this.cognitiveFunctions.sort(byPosition);
    return { lines: this.lines.count, functions: this.cyclomaticFunctions.length,
      cognitiveComplexity: this.cognitive, cyclomaticFunctions: this.cyclomaticFunctions, cognitiveFunctions: this.cognitiveFunctions,
      observations: this.observations, ...(this.grammar.language.measures?.includes('classes') ? { classes: this.classes } : {}) };
  }

  private visit(task: Visit): void {
    const rule = this.grammar.rules[task.node.type];
    if (rule?.flow === 'function') this.scope(task, false);
    else if (rule?.flow === 'class') this.scope(task, true);
    else if (rule?.flow === 'decorated') this.decorated(task);
    else this.control.visit(task, rule);
  }

  private decorated(task: Visit): void {
    const definition = task.node.childForFieldName('definition');
    if (!definition) return;
    const decorators = this.walk.named(task.node).filter(child => child.id !== definition.id);
    this.scope({ ...task, node: definition }, this.grammar.rules[definition.type]?.flow === 'class', decorators);
  }

  private scope({ node, flow, depth }: Visit, isClass: boolean, decorators: readonly Node[] = []): void {
    const body = node.childForFieldName('body');
    const header = this.header(node, body, decorators).map(child => ({ node: child, flow, depth }));
    this.walk.next([...header, () => this.enterScope(node, body, isClass)]);
  }

  private header(node: Node, body: Node | null, decorators: readonly Node[]): readonly Node[] {
    const header = this.walk.named(node).filter(child => child.id !== body?.id);
    if (!decorators.length) return header;
    const annotation = node.childForFieldName('return_type');
    const index = header.findIndex(child => child.id === annotation?.id);
    return index === -1 ? [...header, ...decorators] : [...header.slice(0, index), ...decorators, ...header.slice(index)];
  }

  private enterScope(node: Node, body: Node | null, isClass: boolean): void {
    const simple = this.grammar.name(node);
    const name = simple && [...this.names, simple].join('.');
    const label = name ?? '(anonymous)';
    if (simple) this.names.push(simple);
    this.anchors.push(name ?? [...this.anchors.slice(-1), label].join('.'));
    const own = new Flow();
    this.walk.next([() => {
      if (isClass) this.classes++;
      else this.recordFunction(node, own, label, name);
      this.finish(own, label + ' · Control-flow depth');
      this.anchors.pop();
      if (simple) this.names.pop();
    }]);
    if (body) this.walk.next([{ node: body, flow: own, depth: 0 }]);
  }

  private recordFunction(node: Node, own: Flow, label: string, name: string | undefined): void {
    const line = this.lines.line(node.startIndex);
    const column = this.lines.column(node.startIndex, this.grammar.columns);
    const position = { ...(name ? { name } : {}), line, column };
    this.cyclomaticFunctions.push({ ...position, value: own.cyclomatic });
    this.cognitiveFunctions.push({ ...position, value: own.cognitive });
    this.observe('function-parameters', this.parameters(node), label + ' · Parameters', node);
    this.observe('return-statements', own.returns, label + ' · Return statements', node);
    this.observe('function-complexity', own.cognitive, label + ' · Cognitive complexity', node);
  }

  private parameters(node: Node): number {
    const list = node.childForFieldName('parameters');
    if (!list) return 0;
    const { parameterNames, parameterSeparators } = this.grammar;
    const parameters = this.walk.named(list).filter(item => !parameterSeparators?.has(item.type));
    return parameters.reduce((count, item) =>
      count + (parameterNames ? Math.max(1, item.childrenForFieldName(parameterNames).length) : 1), 0);
  }

  private finish(flow: Flow, label: string): void {
    this.cognitive += flow.cognitive;
    if (flow.deepest) this.observe('nested-control-flow', flow.depth, label, flow.deepest);
  }

  private observe(rule: StructuralCheck, value: number, label: string, node: Node): void {
    const anchor = this.anchors.at(-1);
    const { line, endLine } = this.lines.position({ start: node.startIndex, end: node.endIndex });
    const end = this.grammar.trimObservationComments ? this.codeLines[lowerBound(this.codeLines, endLine + 1) - 1] : endLine;
    this.observations.push({ rule, value, label, line, endLine: Math.max(line, end ?? line), ...(anchor ? { anchor } : {}) });
  }
}
