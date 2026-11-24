import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { parse } from '@babel/parser';
import type { ParserOptions } from '@babel/parser';
import type { Expression, Node } from '@babel/types';
import { pluginApi } from '../../core/engine/plugin.js';
import type { Plugin, RuleDescriptor } from '../../core/engine/plugin.js';
import { findingResult } from '../../core/model/finding.js';
import type { Finding, FindingResult } from '../../core/model/finding.js';
import { sourceFile, utf8 } from '../../core/model/snapshot.js';
import { jsTsExtensions } from './extensions.js';
import { babelTypes, parserDefaults } from './babel-provider.js';
import { children } from './function-facts.js';

const require = createRequire(import.meta.url);

type Level = Finding['level'];
type RuleId = 'eval' | 'child-process-injection' | 'vm-code-execution' | 'dom-xss' | 'tls-verification-disabled'
  | 'weak-hash' | 'insecure-random' | 'http-url';

const catalog: Readonly<Record<RuleId, { readonly level: Level; readonly description: string }>> = {
  'eval': { level: 'high',
    description: 'eval() or the Function constructor runs a string that is not a literal, so injected text becomes code.' },
  'child-process-injection': { level: 'high',
    description: 'child_process exec or execSync runs a shell command built from interpolated or concatenated values.' },
  'vm-code-execution': { level: 'medium',
    description: 'The vm module compiles or runs code that is not a literal, and vm is not a security boundary.' },
  'dom-xss': { level: 'medium',
    description: 'Markup that is not a literal is written through innerHTML, outerHTML, insertAdjacentHTML or document.write.' },
  'tls-verification-disabled': { level: 'high',
    description: 'TLS certificate verification is turned off with rejectUnauthorized or NODE_TLS_REJECT_UNAUTHORIZED.' },
  'weak-hash': { level: 'medium', description: 'createHash or createHmac uses the broken MD5 or SHA-1 algorithm.' },
  'insecure-random': { level: 'low',
    description: 'Math.random() feeds a value named like a token, secret, password, nonce, salt, key or one-time code.' },
  'http-url': { level: 'low', description: 'A string literal points at a plain http:// URL on a public host.' },
};

const tracked = new Set(['child_process', 'vm']);
const shellCalls = new Set(['exec', 'execSync']);
const vmCalls = new Set(['runInThisContext', 'runInNewContext', 'runInContext']);
const weakAlgorithms = new Set(['md5', 'sha1']);
const secretWords = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'nonce', 'salt', 'otp']);
const keyQualifiers = new Set(['api', 'private', 'session', 'access', 'auth', 'encryption', 'signing', 'crypto', 'master']);
// A name ending in one of these holds a number about the secret, such as tokenIndex, not the secret itself.
const quantityWords = new Set(['index', 'idx', 'count', 'length', 'size', 'delay', 'timeout', 'ms']);
const wrappers = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion',
  'ParenthesizedExpression', 'TypeCastExpression']);
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod',
  'ClassMethod', 'ClassPrivateMethod']);

const jsSecurityRules: readonly RuleDescriptor[] = Object.entries(catalog)
  .map(([id, { description }]) => ({ id, category: 'security', description }));

export const jsSecurity: Plugin = {
  id: 'js-security',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['security'],
  claims: { extensions: jsTsExtensions },
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  tools: { '@babel/parser': require('@babel/parser/package.json').version as string, ...babelTypes },
  rules: jsSecurityRules,
  operations: [{
    id: 'scan',
    role: 'inspection',
    inputs: { source: sourceFile },
    output: findingResult,
    execute(inputs): FindingResult {
      const file = inputs.read('source', sourceFile);
      const ast = parseSource(file.path, file.bytes);
      return { measurements: [], findings: ast === undefined ? [] : scan(file.path, ast) };
    },
  }],
};

/** Parses like the babel-syntax provider; a file it rejects is that plugin's diagnostic, not a security finding. */
function parseSource(path: string, bytes: Uint8Array): Node | undefined {
  const ext = extname(path);
  const plugins: NonNullable<ParserOptions['plugins']> = [];
  if (['.ts', '.mts', '.cts', '.tsx'].includes(ext)) {
    plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(path), disallowAmbiguousJSXLike: ext === '.mts' || ext === '.cts' }]);
  }
  if (ext === '.jsx' || ext === '.tsx') plugins.push('jsx');
  const sourceType = ext === '.mjs' || ext === '.mts' ? 'module'
    : ext === '.cjs' || ext === '.cts' ? 'commonjs' : parserDefaults.sourceType;
  try {
    return parse(utf8(bytes), { ...parserDefaults, sourceType, plugins });
  } catch {
    return undefined;
  }
}

interface Imported {
  readonly module: string;
  readonly name: string;
}

/** Local names bound to child_process and vm, collected file-wide without scope analysis. */
interface Bindings {
  readonly namespaces: Map<string, string>;
  readonly named: Map<string, Imported>;
}

function scan(path: string, ast: Node): Finding[] {
  const bindings = collectBindings(ast);
  const findings: Finding[] = [];
  walk(ast, [], (node, ancestors) => {
    const parent = ancestors.at(-1);
    switch (node.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
        inspectCall(node.callee, node.arguments, node, ancestors);
        break;
      case 'NewExpression':
        inspectConstruct(node.callee, node.arguments, node);
        break;
      case 'AssignmentExpression':
        inspectAssignment(node.left, node.right, node.operator, node);
        break;
      case 'ObjectProperty':
        if (propertyKey(node) === 'rejectUnauthorized' && isFalse(node.value)) {
          report('tls-verification-disabled', node, 'Setting rejectUnauthorized to false accepts any TLS certificate, '
            + 'which exposes the connection to man-in-the-middle attacks.');
        }
        break;
      case 'StringLiteral':
        if (parent?.type !== 'TSLiteralType') inspectUrl(node.value, node);
        break;
      case 'TemplateLiteral':
        if (node.expressions.length === 0 && node.quasis[0]?.value.cooked != null) inspectUrl(node.quasis[0].value.cooked, node);
        break;
    }
  });
  return findings.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));

  function inspectCall(callee: Node, args: readonly Node[], node: Node, ancestors: readonly Node[]): void {
    const target = unwrap(callee);
    const [first] = args;
    if (isGlobal(target, 'eval')) {
      if (first !== undefined && !isStatic(first)) {
        report('eval', node, 'eval() runs a string that is not a literal, so attacker-controlled input can execute as code.');
      }
      return;
    }
    if (isGlobal(target, 'Function')) {
      inspectFunctionConstructor(args, node);
      return;
    }
    if (isMathRandom(target)) {
      const name = sinkName(ancestors);
      if (name !== undefined && isSecretName(name)) {
        report('insecure-random', node, `Math.random() is predictable, so ${name} can be guessed; `
          + 'use crypto.randomBytes, randomUUID or getRandomValues instead.');
      }
      return;
    }
    const method = memberName(target);
    if (method === 'createHash' || method === 'createHmac' || (target.type === 'Identifier'
      && (target.name === 'createHash' || target.name === 'createHmac'))) {
      const algorithm = first === undefined ? undefined : staticString(first);
      if (algorithm !== undefined && weakAlgorithms.has(algorithm.toLowerCase())) {
        report('weak-hash', node, `${algorithm.toUpperCase()} is vulnerable to collision attacks and must not protect `
          + 'integrity, signatures or passwords; use SHA-256 or stronger.');
      }
      return;
    }
    if (isDocumentWrite(target)) {
      if (args.some(arg => !isStatic(arg) && !isSanitized(arg))) {
        report('dom-xss', node, 'document.write() with markup that is not a literal lets injected HTML run scripts in the page.');
      }
      return;
    }
    if (method === 'insertAdjacentHTML') {
      const html = args[1];
      if (html !== undefined && !isStatic(html) && !isSanitized(html)) {
        report('dom-xss', node, 'insertAdjacentHTML() with markup that is not a literal lets injected HTML run scripts in the page.');
      }
      return;
    }
    const imported = resolve(target);
    if (imported?.module === 'child_process' && shellCalls.has(imported.name)) {
      if (first !== undefined && isBuiltString(first)) {
        report('child-process-injection', node, `${imported.name}() passes a command built from interpolated values to a shell, `
          + 'so metacharacters in those values can run arbitrary commands; use execFile or spawn with an argument array.');
      }
      return;
    }
    if (imported?.module === 'vm' && vmCalls.has(imported.name) && first !== undefined && !isStatic(first)) {
      report('vm-code-execution', node, `vm.${imported.name}() executes code that is not a literal, and the vm module `
        + 'does not isolate untrusted code from the host process.');
    }
  }

  function inspectConstruct(callee: Node, args: readonly Node[], node: Node): void {
    const target = unwrap(callee);
    if (isGlobal(target, 'Function')) {
      inspectFunctionConstructor(args, node);
      return;
    }
    const imported = resolve(target);
    const [code] = args;
    if (imported?.module === 'vm' && imported.name === 'Script' && code !== undefined && !isStatic(code)) {
      report('vm-code-execution', node, 'new vm.Script() compiles code that is not a literal, and the vm module '
        + 'does not isolate untrusted code from the host process.');
    }
  }

  function inspectFunctionConstructor(args: readonly Node[], node: Node): void {
    const body = args.at(-1);
    if (body !== undefined && !isStatic(body)) {
      report('eval', node, 'The Function constructor compiles a body that is not a literal, '
        + 'so attacker-controlled input can execute as code.');
    }
  }

  function inspectAssignment(left: Node, right: Node, operator: string, node: Node): void {
    const property = memberName(left);
    if ((property === 'innerHTML' || property === 'outerHTML') && (operator === '=' || operator === '+=')) {
      if (!isStatic(right) && !isSanitized(right)) {
        report('dom-xss', node, `Assigning markup that is not a literal to ${property} lets injected HTML run scripts in the page.`);
      }
      return;
    }
    if (property === 'rejectUnauthorized' && operator === '=' && isFalse(right)) {
      report('tls-verification-disabled', node, 'Setting rejectUnauthorized to false accepts any TLS certificate, '
        + 'which exposes the connection to man-in-the-middle attacks.');
      return;
    }
    if (property === 'NODE_TLS_REJECT_UNAUTHORIZED' && operator === '=' && isProcessEnv(unwrap(left))) {
      const value = unwrap(right);
      if ((value.type === 'StringLiteral' && value.value === '0') || (value.type === 'NumericLiteral' && value.value === 0)) {
        report('tls-verification-disabled', node, 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification '
          + 'for every TLS connection in the process, exposing them to man-in-the-middle attacks.');
      }
    }
  }

  function inspectUrl(value: string, node: Node): void {
    if (!value.startsWith('http://')) return;
    const host = /^http:\/\/(?:[^@/?#\s]*@)?(\[[^\]]*\]|[^/:?#\s]*)/.exec(value)?.[1]?.toLowerCase() ?? '';
    if (!isPublicHost(host)) return;
    report('http-url', node, `The plain HTTP URL to ${host} sends data unencrypted, so it can be read or altered in transit; use https.`);
  }

  function resolve(node: Node): Imported | undefined {
    if (node.type === 'Identifier') return bindings.named.get(node.name);
    const name = memberName(node);
    if (name === undefined || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) return undefined;
    const object = unwrap(node.object);
    const module = object.type === 'Identifier' ? bindings.namespaces.get(object.name) : requiredModule(object);
    return module === undefined ? undefined : { module, name };
  }

  function report(rule: RuleId, node: Node, message: string): void {
    const line = node.loc?.start.line ?? 1;
    findings.push({ tool: 'js-security', rule, category: 'security', level: catalog[rule].level, message, path,
      line, endLine: Math.max(line, node.loc?.end.line ?? line) });
  }
}

function collectBindings(ast: Node): Bindings {
  const bindings: Bindings = { namespaces: new Map(), named: new Map() };
  walk(ast, [], node => {
    if (node.type === 'ImportDeclaration') {
      const module = moduleName(node.source.value);
      if (module === undefined || node.importKind === 'type') return;
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          if (specifier.importKind === 'type') continue;
          const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          bindings.named.set(specifier.local.name, { module, name });
        } else {
          bindings.namespaces.set(specifier.local.name, module);
        }
      }
    } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
      const module = moduleName(node.moduleReference.expression.value);
      if (module !== undefined && !node.isExport) bindings.namespaces.set(node.id.name, module);
    } else if (node.type === 'VariableDeclarator' && node.init) {
      bindDeclarator(node.id, unwrap(node.init), bindings);
    }
  });
  return bindings;
}

function bindDeclarator(id: Node, init: Node, bindings: Bindings): void {
  const module = requiredModule(init);
  if (module !== undefined) {
    if (id.type === 'Identifier') bindings.namespaces.set(id.name, module);
    if (id.type !== 'ObjectPattern') return;
    for (const property of id.properties) {
      if (property.type !== 'ObjectProperty') continue;
      const name = propertyKey(property);
      const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
      if (name !== undefined && value.type === 'Identifier') bindings.named.set(value.name, { module, name });
    }
    return;
  }
  if (id.type !== 'Identifier') return;
  // const exec = require('child_process').exec; const run = promisify(exec);
  const member = memberName(init);
  if (member !== undefined && (init.type === 'MemberExpression' || init.type === 'OptionalMemberExpression')) {
    const object = unwrap(init.object);
    const owner = object.type === 'Identifier' ? bindings.namespaces.get(object.name) : requiredModule(object);
    if (owner !== undefined) bindings.named.set(id.name, { module: owner, name: member });
    return;
  }
  if (init.type === 'CallExpression' && init.arguments[0] !== undefined) {
    const callee = unwrap(init.callee);
    if ((callee.type === 'Identifier' && callee.name === 'promisify') || memberName(callee) === 'promisify') {
      const wrapped = unwrap(init.arguments[0]);
      const original = wrapped.type === 'Identifier' ? bindings.named.get(wrapped.name) : undefined;
      if (original !== undefined) bindings.named.set(id.name, original);
      else if (wrapped.type === 'MemberExpression') {
        const object = unwrap(wrapped.object);
        const owner = object.type === 'Identifier' ? bindings.namespaces.get(object.name) : requiredModule(object);
        const name = memberName(wrapped);
        if (owner !== undefined && name !== undefined) bindings.named.set(id.name, { module: owner, name });
      }
    }
  }
}

/** The tracked module that `require('x')` or `await import('x')` loads, if any. */
function requiredModule(node: Node): string | undefined {
  const call = node.type === 'AwaitExpression' ? unwrap(node.argument) : node;
  if (call.type !== 'CallExpression') return undefined;
  const isLoader = (call.callee.type === 'Identifier' && call.callee.name === 'require') || call.callee.type === 'Import';
  const [specifier] = call.arguments;
  return isLoader && specifier?.type === 'StringLiteral' ? moduleName(specifier.value) : undefined;
}

function moduleName(specifier: string): string | undefined {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return tracked.has(name) ? name : undefined;
}

function walk(node: Node, ancestors: Node[], visit: (node: Node, ancestors: readonly Node[]) => void): void {
  visit(node, ancestors);
  ancestors.push(node);
  for (const child of children(node)) walk(child, ancestors, visit);
  ancestors.pop();
}

function unwrap(node: Node): Node {
  let current = node;
  while (wrappers.has(current.type)) current = (current as { expression: Expression }).expression;
  return current;
}

/** A value fixed at write time: literals, expression-free templates and concatenations of those. */
function isStatic(node: Node): boolean {
  const value = unwrap(node);
  switch (value.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NullLiteral': case 'BigIntLiteral': case 'RegExpLiteral':
      return true;
    case 'TemplateLiteral':
      return value.expressions.every(isStatic);
    case 'BinaryExpression':
      return value.operator === '+' && value.left.type !== 'PrivateName' && isStatic(value.left) && isStatic(value.right);
    default:
      return false;
  }
}

/** A template with interpolations or a `+` concatenation whose parts are not all literal. */
function isBuiltString(node: Node): boolean {
  const value = unwrap(node);
  return (value.type === 'TemplateLiteral' || (value.type === 'BinaryExpression' && value.operator === '+')) && !isStatic(value);
}

function staticString(node: Node): string | undefined {
  const value = unwrap(node);
  if (value.type === 'StringLiteral') return value.value;
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) return value.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function isFalse(node: Node): boolean {
  const value = unwrap(node);
  return value.type === 'BooleanLiteral' && !value.value;
}

/** Markup passed through a function named like a sanitizer or escaper, such as DOMPurify.sanitize(html). */
function isSanitized(node: Node): boolean {
  const value = unwrap(node);
  if (value.type !== 'CallExpression' && value.type !== 'OptionalCallExpression') return false;
  const callee = unwrap(value.callee);
  const name = callee.type === 'Identifier' ? callee.name : memberName(callee);
  return name !== undefined && /sanitize|escape/i.test(name);
}

function memberName(node: Node): string | undefined {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'StringLiteral') return node.property.value;
  return undefined;
}

function propertyKey(node: Node): string | undefined {
  if (node.type !== 'ObjectProperty' && node.type !== 'ClassProperty' && node.type !== 'ObjectMethod'
    && node.type !== 'ClassMethod' && node.type !== 'ClassPrivateProperty' && node.type !== 'ClassPrivateMethod') return undefined;
  const key = node.key;
  if (key.type === 'PrivateName') return key.id.name;
  if (node.type !== 'ClassPrivateProperty' && node.type !== 'ClassPrivateMethod' && node.computed) {
    return key.type === 'StringLiteral' ? key.value : undefined;
  }
  return key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : undefined;
}

/** `eval`, `Function` or the same name read from globalThis, window, self or global. */
function isGlobal(node: Node, name: string): boolean {
  if (node.type === 'Identifier') return node.name === name;
  if (memberName(node) !== name || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) return false;
  const object = unwrap(node.object);
  return object.type === 'Identifier' && ['globalThis', 'window', 'self', 'global'].includes(object.name);
}

function isMathRandom(node: Node): boolean {
  if (memberName(node) !== 'random' || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) return false;
  const object = unwrap(node.object);
  return object.type === 'Identifier' && object.name === 'Math';
}

function isDocumentWrite(node: Node): boolean {
  const name = memberName(node);
  if ((name !== 'write' && name !== 'writeln') || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) return false;
  const object = unwrap(node.object);
  return isGlobal(object, 'document');
}

function isProcessEnv(node: Node): boolean {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
  const env = unwrap(node.object);
  if (memberName(env) !== 'env' || (env.type !== 'MemberExpression' && env.type !== 'OptionalMemberExpression')) return false;
  const process = unwrap(env.object);
  return process.type === 'Identifier' && process.name === 'process';
}

/**
 * The name a value is stored under, found by climbing from the expression to the nearest declarator, assignment,
 * property or return. A returned value takes the enclosing function's name; any other statement ends the search.
 */
function sinkName(ancestors: readonly Node[]): string | undefined {
  let returning = false;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index]!;
    if (functionTypes.has(node.type)) {
      const own = functionOwnName(node);
      if (own !== undefined) return own;
      returning = false;
      continue;
    }
    if (returning) continue;
    switch (node.type) {
      case 'VariableDeclarator':
        return node.id.type === 'Identifier' ? node.id.name : undefined;
      case 'AssignmentExpression': {
        const left = unwrap(node.left);
        return left.type === 'Identifier' ? left.name : memberName(left);
      }
      case 'ObjectProperty': case 'ClassProperty': case 'ClassPrivateProperty':
        return propertyKey(node);
      case 'JSXAttribute':
        return node.name.type === 'JSXIdentifier' ? node.name.name : node.name.name.name;
      case 'JSXElement': case 'JSXFragment':
        return undefined;
      case 'ReturnStatement':
        returning = true;
        continue;
    }
    if (isStatementLike(node)) return undefined;
  }
  return undefined;
}

function functionOwnName(node: Node): string | undefined {
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) return node.id.name;
  return propertyKey(node);
}

function isStatementLike(node: Node): boolean {
  return node.type.endsWith('Statement') || node.type.endsWith('Declaration') || node.type === 'Program'
    || node.type === 'SwitchCase' || node.type === 'CatchClause' || node.type === 'StaticBlock';
}

/** Splits camelCase, PascalCase and snake_case names into words and looks for secret-bearing ones. */
export function isSecretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 0);
  if (words.length === 0 || quantityWords.has(words.at(-1)!)) return false;
  // Bare `key` is too common for list and cache keys, so it counts only with a qualifier such as apiKey or sessionKey.
  return words.some((word, index) => matches(secretWords, word)
    || ((word === 'key' || word === 'keys') && words.some((other, position) => position !== index && matches(keyQualifiers, other))));
}

function matches(set: ReadonlySet<string>, word: string): boolean {
  return set.has(word) || (word.endsWith('s') && set.has(word.slice(0, -1)));
}

function isPublicHost(host: string): boolean {
  if (host === '' || host.startsWith('[')) return false;
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return false;
  if (host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.localhost')) return false;
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  // XML namespaces and JSON Schema $schema ids are identifiers that are never fetched.
  return !under('example.com') && !under('example.org') && !under('example.net') && !under('w3.org') && !under('json-schema.org')
    && !host.startsWith('schemas.');
}
