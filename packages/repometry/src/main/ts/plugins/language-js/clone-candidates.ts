import { NODE_FIELDS, VISITOR_KEYS, isFunction, isStatement } from '@babel/types';
import type { Node } from '@babel/types';
import { createHash } from 'node:crypto';
import type { Candidate, CloneSource } from '../../core/model/clone-source.js';
import { duplicationSettings } from '../../core/profile/maintainability.js';

export function cloneCandidates(path: string, ast: Node, codeLines: readonly number[]): CloneSource {
  const candidates: Candidate[] = [];
  if (codeLines.length >= duplicationSettings.minCodeLines) walk(ast);
  return { path, codeLines, candidates };

  function walk(node: Node): { exact: string; similar: string; nodes: number } {
    let nodes = 1;
    const exact: unknown[] = [node.type];
    const similar: unknown[] = [node.type];
    const properties = node as unknown as Record<string, unknown>;
    const keys = VISITOR_KEYS[node.type] ?? [];
    for (const key of keys) {
      const value = properties[key];
      const descendants = (Array.isArray(value) ? value : [value]).map((child: Node | null | undefined) => child ? walk(child) : null);
      for (const descendant of descendants) nodes += descendant?.nodes ?? 0;
      exact.push(descendants.map(descendant => descendant?.exact ?? null));
      similar.push(descendants.map(descendant => descendant?.similar ?? null));
    }
    for (const key of Object.keys(NODE_FIELDS[node.type] ?? {})) {
      if (keys.includes(key)) continue;
      const value = properties[key] ?? null;
      exact.push(value);
      similar.push(normalized(node.type, key) ? null : value);
    }
    const fingerprint = { exact: hash(exact), similar: hash(similar), nodes };
    const { start, end, loc } = node;
    const eligible = (isFunction(node) || isStatement(node) || node.type === 'SwitchCase') && node.type !== 'EmptyStatement';
    if (eligible && nodes >= duplicationSettings.minNodes && loc && start != null && end != null) {
      const endLine = loc.end.line - Number(loc.end.column === 0);
      const codeCount = firstAtLeast(codeLines, endLine + 1) - firstAtLeast(codeLines, loc.start.line);
      if (codeCount >= duplicationSettings.minCodeLines) {
        candidates.push({ ...fingerprint, start, end, line: loc.start.line, endLine, codeLines: codeCount });
      }
    }
    return fingerprint;
  }
}

function normalized(type: Node['type'], property: string): boolean {
  if ((type === 'Identifier' || type === 'JSXIdentifier') && property === 'name') return true;
  if (type === 'RegExpLiteral' && property === 'pattern') return true;
  return property === 'value' && (type.endsWith('Literal') || type === 'TemplateElement');
}

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

function firstAtLeast(numbers: readonly number[], number: number): number {
  let left = 0;
  let right = numbers.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (numbers[middle]! < number) left = middle + 1;
    else right = middle;
  }
  return left;
}
