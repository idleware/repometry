import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { traverseFast } from '@babel/types';
import type { Node } from '@babel/types';

const retired = /\b(?:rule|rules|claim|claims|kinds|settings|providesLanguages|sources|pathGlobs|tool)\b/i;
const migration = new Set([
  'Config sources is renamed. Write source.',
  '/pathGlobs is renamed. Write include.',
  '/tool is renamed. Write plugin.',
  '/rule is renamed. Write check.',
]);
const executableTool = /\b(?:tool (?:command|timeout|output limit|cleanup|versions|timed out|exceeded)|Docker tool|start the tool)\b/gi;
const emitters = new Map([
  ['Error', 0], ['TypeError', 0], ['RangeError', 0], ['AggregateError', 1],
  ['emitDiagnostic', 0], ['report', 2], ['write', 0], ['warn', 0], ['toolFailure', 0],
]);

export function retiredProductionMessages(): readonly string[] {
  const violations: string[] = [];
  for (const pkg of readdirSync('..', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const source = join(pkg.parentPath, pkg.name, 'src/main/ts');
    if (!existsSync(source)) continue;
    for (const file of readdirSync(source, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      const path = join(file.parentPath, file.name);
      for (const message of retiredMessages(readFileSync(path, 'utf8'))) {
        violations.push(`${path}:${message.line} ${message.text}`);
      }
    }
  }
  return violations.sort();
}

export function retiredMessages(source: string) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'importAttributes'] });
  const violations = new Map<number, { line: number; text: string }>();
  traverseFast(ast, node => {
    const message = emittedValue(node);
    if (message === undefined) return;
    const text = messageText(message).trim();
    if (migration.has(text) || !retired.test(text.replace(executableTool, ''))) return;
    if (message.start != null) violations.set(message.start, { line: message.loc?.start.line ?? 0, text });
  });
  return [...violations.values()];
}

function emittedValue(node: Node): Node | undefined {
  switch (node.type) {
    case 'ThrowStatement':
      return emittedValue(node.argument) ?? node.argument;
    case 'NewExpression':
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const index = emitters.get(callName(node.callee));
      return index === undefined ? undefined : node.arguments[index];
    }
    case 'ObjectProperty':
      return /^(?:message|reason)$/.test(callName(node.key)) ? node.value : undefined;
    case 'VariableDeclarator':
      return /(?:message|note|reason|diagnostic)$/i.test(callName(node.id)) ? node.init ?? undefined : undefined;
    default:
      return undefined;
  }
}

function callName(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return callName(node.property);
  return '';
}

function messageText(node: Node): string {
  let text = '';
  switch (node.type) {
    case 'StringLiteral':
      text = node.value;
      break;
    case 'TemplateLiteral':
      text = node.quasis.map(part => part.value.cooked ?? part.value.raw).join(' … ');
      break;
    case 'BinaryExpression':
      if (node.operator === '+') text = messageText(node.left) + messageText(node.right);
      break;
    case 'ConditionalExpression':
      text = messageText(node.consequent) + '\n' + messageText(node.alternate);
      break;
    case 'LogicalExpression':
      text = messageText(node.left) + '\n' + messageText(node.right);
      break;
    case 'NewExpression':
    case 'CallExpression':
    case 'OptionalCallExpression':
      text = node.arguments.map(messageText).join('\n');
      break;
  }
  return text;
}
