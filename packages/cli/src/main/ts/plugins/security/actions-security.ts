import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { Finding, FindingResult } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';

const tool = 'actions-security';

const ruleCatalog = {
  'unpinned-action': { level: 'medium',
    description: 'A third-party action or reusable workflow is referenced by a tag or branch instead of a full commit SHA.' },
  'unpinned-first-party-action': { level: 'low',
    description: 'An action owned by actions or github is referenced by a tag or branch instead of a full commit SHA.' },
  'script-injection': { level: 'high',
    description: 'A run script expands attacker-controlled context, such as an issue title or a branch name, directly into the shell.' },
  'pull-request-target-checkout': { level: 'high',
    description: 'A pull_request_target or workflow_run workflow checks out untrusted pull request code in a privileged job.' },
  'excessive-permissions': { level: 'medium',
    description: 'The workflow or one of its jobs grants the GITHUB_TOKEN write-all permissions.' },
  'missing-permissions': { level: 'low',
    description: 'Neither the workflow nor any of its jobs declares permissions, so the GITHUB_TOKEN gets the repository default.' },
  'persisted-credentials': { level: 'low',
    description: 'An actions/checkout step leaves the GITHUB_TOKEN in the git config because persist-credentials is not false.' },
  'secrets-inherit': { level: 'low',
    description: 'A reusable workflow call passes every repository secret with secrets: inherit.' },
} as const satisfies Readonly<Record<string, { readonly level: Finding['level']; readonly description: string }>>;

type RuleId = keyof typeof ruleCatalog;

export const actionsSecurity: Plugin = {
  id: tool, version: '1.0.0', api: pluginApi,
  kinds: ['security'],
  claims: { globs: ['.github/workflows/*.yml', '.github/workflows/*.yaml', 'action.yml', 'action.yaml'] },
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  rules: Object.entries(ruleCatalog).map(([id, { description }]) => ({ id, category: 'infrastructure', description })),
  operations: [{
    id: 'scan', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
    execute(inputs): FindingResult {
      const { path, bytes } = inputs.read('source', sourceFile);
      return { measurements: [], findings: audit(path, new TextDecoder().decode(bytes)) };
    },
  }],
};

// Audits

type Report = (rule: RuleId, line: number, message: string) => void;

interface LocatedFinding extends Finding {
  readonly line: number;
}

function audit(path: string, text: string): Finding[] {
  const root = new YamlReader(text).read();
  const findings = new Map<string, LocatedFinding>();
  const report: Report = (rule, line, message) => {
    // Aliased nodes are visited once per alias; report each location once.
    const key = `${rule}\0${line}\0${message}`;
    if (!findings.has(key)) {
      findings.set(key, { tool, rule, category: 'infrastructure', level: ruleCatalog[rule].level, message, path, line });
    }
  };
  const jobs = entryOf(root, 'jobs');
  if (jobs) auditWorkflow(root, jobs, report);
  else for (const step of itemsOf(valueOf(valueOf(root, 'runs'), 'steps'))) auditStep(step, undefined, report);
  return [...findings.values()].sort((left, right) => left.line - right.line || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0));
}

function auditWorkflow(root: YamlNode, jobs: Entry, report: Report): void {
  const events = triggers(valueOf(root, 'on'));
  const privileged = ['pull_request_target', 'workflow_run'].find(event => events.has(event));
  const top = entryOf(root, 'permissions');
  let declared = top !== undefined;
  if (top) auditPermissions(top, 'The workflow', report);
  for (const job of jobs.value.kind === 'map' ? jobs.value.entries : []) {
    const permissions = entryOf(job.value, 'permissions');
    if (permissions) {
      declared = true;
      auditPermissions(permissions, `Job ${job.key}`, report);
    }
    const call = entryOf(job.value, 'uses');
    if (call) {
      auditPinning(call, 'Reusable workflow', report);
      const secrets = entryOf(job.value, 'secrets');
      if (secrets && textOf(secrets.value)?.trim() === 'inherit') {
        report('secrets-inherit', secrets.line,
          `Job ${job.key} passes every repository secret to the called workflow with secrets: inherit instead of only the secrets it needs.`);
      }
    }
    for (const step of itemsOf(valueOf(job.value, 'steps'))) auditStep(step, privileged, report);
  }
  if (!declared) {
    report('missing-permissions', jobs.line,
      'No permissions are set for the workflow or any of its jobs, so the GITHUB_TOKEN gets the repository default, which may allow writes.');
  }
}

function triggers(node: YamlNode | undefined): ReadonlySet<string> {
  if (node === undefined) return new Set();
  if (node.kind === 'scalar') return new Set([node.value.trim()]);
  if (node.kind === 'list') return new Set(node.items.flatMap(item => item.kind === 'scalar' ? [item.value.trim()] : []));
  return new Set(node.entries.map(entry => entry.key));
}

function auditPermissions(permissions: Entry, subject: string, report: Report): void {
  if (textOf(permissions.value)?.trim().toLowerCase() !== 'write-all') return;
  report('excessive-permissions', permissions.line,
    `${subject} sets permissions: write-all, which gives the GITHUB_TOKEN write access to every scope.`);
}

function auditPinning(uses: Entry, subject: string, report: Report): void {
  const reference = textOf(uses.value)?.trim();
  if (!reference || reference.startsWith('./') || /^docker:\/\//i.test(reference) || reference.includes('${{')) return;
  const at = reference.lastIndexOf('@');
  if (at <= 0) return;
  const name = reference.slice(0, at);
  const ref = reference.slice(at + 1);
  if (/^[0-9a-f]{40}$/i.test(ref)) return;
  const owner = name.split('/')[0]!.toLowerCase();
  if (owner === 'actions' || owner === 'github') {
    report('unpinned-first-party-action', uses.line,
      `${subject} ${name}@${ref} is not pinned to a full commit SHA, so the code behind that ref can still change.`);
  } else {
    report('unpinned-action', uses.line,
      `${subject} ${name}@${ref} is not pinned to a full commit SHA, so whoever controls that ref can change the code this workflow runs.`);
  }
}

// PR head refs, PR merge refs and the workflow_run head all point at code the pull request author controls.
const untrustedCheckout = /github\.event\.pull_request\.head\.|github\.event\.pull_request\.merge_commit_sha|github\.head_ref|github\.event\.workflow_run\.head_|refs\/pull\//;

function auditStep(step: YamlNode, privileged: string | undefined, report: Report): void {
  const uses = entryOf(step, 'uses');
  const action = textOf(uses?.value)?.trim();
  if (uses && action !== undefined) {
    auditPinning(uses, 'Action', report);
    if (/^actions\/checkout(?:@|$)/i.test(action)) {
      const inputs = valueOf(step, 'with');
      const persist = textOf(valueOf(inputs, 'persist-credentials'))?.trim();
      if (persist === undefined || (persist.toLowerCase() !== 'false' && !persist.includes('${{'))) {
        report('persisted-credentials', uses.line,
          'This actions/checkout step keeps the GITHUB_TOKEN in .git/config for every later step because persist-credentials is not set to false.');
      }
      const source = privileged === undefined ? undefined : ['ref', 'repository'].map(key => entryOf(inputs, key))
        .find(entry => entry !== undefined && untrustedCheckout.test(normalize(textOf(entry.value) ?? '')));
      if (source) {
        report('pull-request-target-checkout', source.line,
          `This ${privileged} workflow checks out untrusted pull request code from ${textOf(source.value)!.trim()} in a job that can read secrets and write to the repository.`);
      }
    }
  }
  const run = valueOf(step, 'run');
  if (run?.kind === 'scalar') auditScript(run, report);
}

function auditScript(script: Scalar, report: Report): void {
  const { fragments } = script;
  const starts: number[] = [];
  let offset = 0;
  for (const fragment of fragments) {
    starts.push(offset);
    offset += fragment.text.length + 1;
  }
  const source = fragments.map(fragment => fragment.text).join('\n');
  for (const match of source.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const contexts = untrustedContexts(match[1]!);
    if (contexts.length === 0) continue;
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= match.index) index++;
    report('script-injection', fragments[index]?.line ?? script.line,
      `The run script expands ${contexts.join(', ')} directly into the shell, so a crafted value can run arbitrary commands; pass it through an env variable instead.`);
  }
}

// Context an outside contributor can set through an issue, a comment, a pull request, a branch name or a commit.
const untrustedContext = new RegExp(String.raw`(?<![\w.-])(?:github\.head_ref|github\.event\.(?:`
  + String.raw`issue\.(?:title|body)|pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))|comment\.body|review\.body`
  + String.raw`|discussion\.(?:title|body)|pages\.\*\.page_name|commits\.\*\.(?:message|author\.(?:name|email)|committer\.(?:name|email))`
  + String.raw`|head_commit\.(?:message|author\.(?:name|email)|committer\.(?:name|email))`
  + String.raw`|workflow_run\.(?:head_branch|head_commit\.(?:message|author\.(?:name|email)))))(?![\w-])`, 'g');

function untrustedContexts(expression: string): string[] {
  const source = normalize(expression).replace(/'(?:[^']|'')*'/g, literal => `'${'_'.repeat(literal.length - 2)}'`);
  const found = new Set<string>();
  for (const match of source.matchAll(untrustedContext)) {
    if (!isBooleanOperand(source, match.index, match.index + match[0].length)) found.add(match[0]);
  }
  return [...found];
}

/** Expression property access is case-insensitive and may use index syntax: github.event['issue'].title, commits[0]. */
function normalize(expression: string): string {
  return expression.toLowerCase()
    .replace(/\[\s*(['"])([^'"]*)\1\s*\]/g, '.$2')
    .replace(/\[\s*(?:\*|\d+)\s*\]/g, '.*');
}

/** A comparison or contains/startsWith/endsWith call turns the untrusted value into a boolean, which is safe to expand. */
function isBooleanOperand(source: string, start: number, end: number): boolean {
  if (/(?:[=!<>]=|[<>!])$/.test(source.slice(0, start).trimEnd()) || /^(?:[=!<>]=|[<>])/.test(source.slice(end).trimStart())) return true;
  let depth = 0;
  for (let index = start - 1; index >= 0; index--) {
    if (source[index] === ')') depth++;
    else if (source[index] === '(') {
      if (depth > 0) depth--;
      else if (/(?:^|[^\w.])(?:contains|startswith|endswith)\s*$/.test(source.slice(0, index))) return true;
    }
  }
  return false;
}

// A line-based reader for the YAML subset that workflow files use: block mappings and sequences by indentation,
// plain, quoted and block scalars, single-line or multi-line flow collections, comments, anchors and aliases.
// Every node keeps the line it starts on, and scalars keep their source lines so expressions can be located.

interface Fragment {
  readonly text: string;
  readonly line: number;
}

interface Scalar {
  readonly kind: 'scalar';
  readonly value: string;
  readonly line: number;
  readonly fragments: readonly Fragment[];
}

interface Mapping {
  readonly kind: 'map';
  readonly line: number;
  readonly entries: readonly Entry[];
}

interface Sequence {
  readonly kind: 'list';
  readonly line: number;
  readonly items: readonly YamlNode[];
}

type YamlNode = Scalar | Mapping | Sequence;

interface Entry {
  readonly key: string;
  readonly line: number;
  readonly value: YamlNode;
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly line: number;
}

function scalar(value: string, line: number, fragments: readonly Fragment[] = []): Scalar {
  return { kind: 'scalar', value, line, fragments };
}

function entryOf(node: YamlNode | undefined, key: string): Entry | undefined {
  return node?.kind === 'map' ? node.entries.find(entry => entry.key === key) : undefined;
}

function valueOf(node: YamlNode | undefined, key: string): YamlNode | undefined {
  return entryOf(node, key)?.value;
}

function textOf(node: YamlNode | undefined): string | undefined {
  return node?.kind === 'scalar' ? node.value : undefined;
}

function itemsOf(node: YamlNode | undefined): readonly YamlNode[] {
  return node?.kind === 'list' ? node.items : [];
}

const keyPattern = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#"'&*!|>%@`,[\]{}?:-][^#]*?|[?:-][^\s#][^#]*?))[ \t]*:(?=\s|$)/;
const propertyPattern = /^([&!])(\S*)(?:\s+|$)/;

function isItem(text: string): boolean {
  return /^-(?:\s|$)/.test(text);
}

function indentOf(raw: string): number {
  return raw.length - raw.trimStart().length;
}

class YamlReader {
  private position = 0;
  private readonly anchors = new Map<string, YamlNode>();
  private readonly lines: string[];

  constructor(text: string) {
    this.lines = text.split(/\r\n|\r|\n/);
  }

  read(): YamlNode {
    return this.node(-1) ?? scalar('', 1);
  }

  /** The next line with content; blank lines, comment lines and document markers are skipped. */
  private peek(): Line | undefined {
    for (; this.position < this.lines.length; this.position++) {
      const raw = this.lines[this.position]!;
      const text = raw.trim();
      if (text === '' || text.startsWith('#') || /^(?:(?:---|\.\.\.)(?:\s|$)|%)/.test(raw)) continue;
      return { indent: indentOf(raw), text, line: this.position + 1 };
    }
    return undefined;
  }

  private node(parent: number): YamlNode | undefined {
    const next = this.peek();
    if (next === undefined || next.indent <= parent) return undefined;
    if (isItem(next.text)) return this.sequence(next.indent, next.line);
    if (keyPattern.test(next.text)) return this.mapping(next.indent, next.line);
    this.position++;
    return this.inline(next.text, parent, next.line, false);
  }

  private sequence(indent: number, line: number): Sequence {
    const items: YamlNode[] = [];
    for (let next = this.peek(); next !== undefined && next.indent >= indent; next = this.peek()) {
      if (next.indent > indent) {
        this.position++; // A line no node owns: skip it rather than end the document.
        continue;
      }
      if (!isItem(next.text)) break;
      // Blank out the dash so the item content reads as a node indented past the sequence.
      const raw = this.lines[this.position]!;
      this.lines[this.position] = `${raw.slice(0, indent)} ${raw.slice(indent + 1)}`;
      items.push(this.node(indent) ?? scalar('', next.line));
    }
    return { kind: 'list', line, items };
  }

  private mapping(indent: number, line: number): Mapping {
    const entries: Entry[] = [];
    for (let next = this.peek(); next !== undefined && next.indent >= indent; next = this.peek()) {
      if (next.indent > indent) {
        this.position++;
        continue;
      }
      const key = keyPattern.exec(next.text);
      if (key === null) break;
      this.position++;
      const name = key[1] !== undefined ? unescape(key[1]) : key[2] !== undefined ? key[2].replaceAll("''", "'") : key[3]!.trimEnd();
      entries.push({ key: name, line: next.line, value: this.inline(next.text.slice(key[0].length), indent, next.line, true) });
    }
    return { kind: 'map', line, entries };
  }

  /** The value written after `key:` or `- `; `owner` is the indent its continuation lines must exceed. */
  private inline(text: string, owner: number, line: number, mapValue: boolean): YamlNode {
    let rest = text.trim();
    let anchor: string | undefined;
    for (let property = propertyPattern.exec(rest); property !== null && rest !== ''; property = propertyPattern.exec(rest)) {
      if (property[1] === '&') anchor = property[2];
      rest = rest.slice(property[0].length);
    }
    const node = this.value(rest, owner, line, mapValue);
    if (anchor) this.anchors.set(anchor, node);
    return node;
  }

  private value(text: string, owner: number, line: number, mapValue: boolean): YamlNode {
    if (text === '' || text.startsWith('#')) return this.nested(owner, line, mapValue);
    const alias = /^\*(\S+)(?:\s+#.*)?$/.exec(text);
    if (alias) return this.anchors.get(alias[1]!) ?? scalar(text, line, [{ text, line }]);
    if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.test(text)) return this.block(text, owner, line);
    if (text.startsWith('[') || text.startsWith('{')) return this.flow(text, owner, line);
    if (text.startsWith('"') || text.startsWith("'")) return this.quoted(text, owner, line);
    return this.plain(text, owner, line);
  }

  private nested(owner: number, line: number, mapValue: boolean): YamlNode {
    const next = this.peek();
    if (next !== undefined && next.indent > owner) return this.node(owner) ?? scalar('', line);
    // A sequence may sit at the same indent as the key that owns it.
    if (mapValue && next !== undefined && next.indent === owner && isItem(next.text)) return this.sequence(owner, next.line);
    return scalar('', line);
  }

  private block(header: string, owner: number, line: number): Scalar {
    const explicit = Number(/[1-9]/.exec(header)?.[0] ?? 0);
    let indent = explicit > 0 ? Math.max(owner, 0) + explicit : undefined;
    const fragments: Fragment[] = [];
    let last = -1;
    for (let index = this.position; index < this.lines.length; index++) {
      const raw = this.lines[index]!;
      if (raw.trim() === '') continue;
      const depth = indentOf(raw);
      if (indent === undefined && depth > owner) indent = depth;
      if (indent === undefined || depth < indent) break;
      if (last >= 0) for (let blank = last + 1; blank < index; blank++) fragments.push({ text: '', line: blank + 1 });
      fragments.push({ text: raw.slice(indent), line: index + 1 });
      last = index;
    }
    if (last >= 0) this.position = last + 1;
    const joined = fragments.map(fragment => fragment.text).join('\n');
    return scalar(header.startsWith('|') ? joined : joined.replace(/([^\n])\n(?=\S)/g, '$1 '), line, fragments);
  }

  private plain(text: string, owner: number, line: number): Scalar {
    const first = uncomment(text);
    const fragments: Fragment[] = [{ text: first.text, line }];
    for (let ended = first.commented; !ended;) {
      let index = this.position;
      while (index < this.lines.length && this.lines[index]!.trim() === '') index++;
      const raw = this.lines[index];
      if (raw === undefined || indentOf(raw) <= owner || raw.trim().startsWith('#')) break;
      const next = uncomment(raw.trim());
      fragments.push({ text: next.text, line: index + 1 });
      this.position = index + 1;
      ended = next.commented;
    }
    return scalar(fragments.map(fragment => fragment.text).join(' '), line, fragments);
  }

  private quoted(text: string, owner: number, line: number): Scalar {
    const quote = text[0]!;
    const fragments: Fragment[] = [{ text, line }];
    let source = text.slice(1);
    let close = closing(source, quote);
    while (close < 0 && this.position < this.lines.length) {
      const raw = this.lines[this.position]!;
      if (raw.trim() !== '' && indentOf(raw) <= owner) break;
      this.position++;
      fragments.push({ text: raw.trim(), line: this.position });
      source += `\n${raw.trim()}`;
      close = closing(source, quote);
    }
    return scalar(cook(close < 0 ? source : source.slice(0, close), quote), line, fragments);
  }

  private flow(text: string, owner: number, line: number): YamlNode {
    let source = text;
    while (!balanced(source) && this.position < this.lines.length) {
      const raw = this.lines[this.position]!;
      if (raw.trim() !== '' && indentOf(raw) <= owner) break;
      source += `\n${raw}`;
      this.position++;
    }
    return new FlowReader(source, line).read();
  }
}

/** Reads one flow collection such as `[push, pull_request]` or `{ persist-credentials: false }`. */
class FlowReader {
  private index = 0;

  constructor(private readonly source: string, private readonly line: number) {}

  read(): YamlNode {
    return this.node();
  }

  private lineAt(index: number): number {
    let line = this.line;
    for (let newline = this.source.indexOf('\n'); newline >= 0 && newline < index; newline = this.source.indexOf('\n', newline + 1)) line++;
    return line;
  }

  private space(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === '#' && (this.index === 0 || /\s/.test(this.source[this.index - 1]!))) {
        const newline = this.source.indexOf('\n', this.index);
        this.index = newline < 0 ? this.source.length : newline;
      } else if (/\s/.test(char)) this.index++;
      else break;
    }
  }

  private node(): YamlNode {
    this.space();
    const line = this.lineAt(this.index);
    const char = this.source[this.index];
    if (char === '[') return this.sequence(line);
    if (char === '{') return this.mapping(line);
    if (char === '"' || char === "'") return this.quoted(line);
    return this.plain(line);
  }

  private sequence(line: number): Sequence {
    const items: YamlNode[] = [];
    this.index++;
    for (;;) {
      this.space();
      const char = this.source[this.index];
      if (char === undefined) break;
      if (char === ']') {
        this.index++;
        break;
      }
      if (char === ',') {
        this.index++;
        continue;
      }
      const start = this.index;
      items.push(this.node());
      if (this.index === start) this.index++;
    }
    return { kind: 'list', line, items };
  }

  private mapping(line: number): Mapping {
    const entries: Entry[] = [];
    this.index++;
    for (;;) {
      this.space();
      const char = this.source[this.index];
      if (char === undefined) break;
      if (char === '}') {
        this.index++;
        break;
      }
      if (char === ',') {
        this.index++;
        continue;
      }
      const start = this.index;
      const key = this.node();
      this.space();
      let value: YamlNode = scalar('', key.line);
      if (this.source[this.index] === ':') {
        this.index++;
        this.space();
        const next = this.source[this.index];
        if (next !== undefined && next !== ',' && next !== '}') value = this.node();
      }
      entries.push({ key: textOf(key) ?? '', line: key.line, value });
      if (this.index === start) this.index++;
    }
    return { kind: 'map', line, entries };
  }

  private quoted(line: number): Scalar {
    const quote = this.source[this.index]!;
    const close = closing(this.source.slice(this.index + 1), quote);
    const end = close < 0 ? this.source.length : this.index + 1 + close;
    const raw = this.source.slice(this.index, end + 1);
    const body = this.source.slice(this.index + 1, end);
    this.index = Math.min(end + 1, this.source.length);
    return scalar(cook(body, quote), line, [{ text: raw, line }]);
  }

  private plain(line: number): Scalar {
    const start = this.index;
    let end = start;
    while (this.index < this.source.length) {
      // Expressions are kept whole even when they are not quoted, although their braces end a plain scalar in YAML.
      if (this.source.startsWith('${{', this.index)) {
        const close = this.source.indexOf('}}', this.index + 3);
        this.index = close < 0 ? this.source.length : close + 2;
        end = this.index;
        continue;
      }
      const char = this.source[this.index]!;
      const next = this.source[this.index + 1];
      if (',[]{}'.includes(char) || (char === ':' && (next === undefined || /[\s,[\]{}]/.test(next)))
        || (char === '#' && /\s/.test(this.source[this.index - 1] ?? ' '))) break;
      this.index++;
      if (!/\s/.test(char)) end = this.index;
    }
    const raw = this.source.slice(start, end);
    return scalar(raw.replace(/\s*\n\s*/g, ' '), line, [{ text: raw, line }]);
  }
}

function uncomment(text: string): { readonly text: string; readonly commented: boolean } {
  const comment = /(?:^|[ \t])#/.exec(text);
  return comment ? { text: text.slice(0, comment.index).trimEnd(), commented: true } : { text: text.trimEnd(), commented: false };
}

/** The index of the quote that closes a scalar whose opening quote precedes `source`, or -1. */
function closing(source: string, quote: string): number {
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote === '"' && char === '\\') index++;
    else if (char === quote) {
      if (quote === "'" && source[index + 1] === "'") index++;
      else return index;
    }
  }
  return -1;
}

function balanced(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if ((char === '"' || char === "'") && /(?:^|[[{,:])$/.test(source.slice(0, index).trimEnd())) {
      const close = closing(source.slice(index + 1), char);
      if (close < 0) return false;
      index += close + 1;
    } else if (char === '#' && (index === 0 || /\s/.test(source[index - 1]!))) {
      const newline = source.indexOf('\n', index);
      if (newline < 0) break;
      index = newline;
    } else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
  }
  return depth <= 0;
}

const escapes: Readonly<Record<string, string>> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', N: '\x85', _: '\xa0', L: ' ', P: ' ',
};

/** The value of a quoted scalar body: line breaks fold to spaces, double-quoted escapes are decoded. */
function cook(body: string, quote: string): string {
  const folded = body.replace(/[ \t]*\n[ \t]*/g, ' ');
  return quote === '"' ? unescape(folded) : folded.replaceAll("''", "'");
}

function unescape(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, code: string) => {
    if (code.length === 1) return escapes[code] ?? code;
    const point = parseInt(code.slice(1), 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : code;
  });
}
