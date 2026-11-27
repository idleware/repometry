import { isRecord, pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { Finding, FindingResult } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';

const tool = 'npm-supply-chain';

const ruleDescriptions = {
  'dependency-from-url': 'A package.json dependency is installed from a URL, git repository or tarball instead of a registry version.',
  'dependency-unbounded': 'A package.json dependency accepts any version through "*", "latest" or an empty range.',
  'install-script': 'A package.json declares a preinstall, install or postinstall script that runs whenever the package is installed.',
  'lockfile-insecure-registry': 'A lockfile resolves a package over unencrypted HTTP or git transport.',
  'lockfile-foreign-host': 'A lockfile resolves a package from a host other than the public npm or Yarn registry.',
  'lockfile-missing-integrity': 'A package-lock entry resolved from a registry has no integrity hash.',
} as const;

type Rule = keyof typeof ruleDescriptions;
type Level = 'low' | 'medium' | 'high';

/** Above this many hits of one rule in one file, the rest collapse into a single summary finding. */
export const findingsPerRule = 20;

const registryHosts = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const insecureProtocols = new Set(['http', 'git', 'git+http']);
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const installScripts = ['preinstall', 'install', 'postinstall'] as const;
const levelOrder: readonly Level[] = ['low', 'medium', 'high'];
/** A repository page URL such as https://github.com/owner/repo, which npm clones with git. */
const hostedRepository = /^https:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/?#]+\/[^/?#]+\/?(?:#.*)?$/i;

interface Hit {
  readonly rule: Rule;
  readonly level: Level;
  readonly message: string;
  readonly line?: number;
  readonly endLine?: number;
}

/** A hit in a JSON file, addressed by its key path until the line locator resolves it. */
interface JsonHit extends Omit<Hit, 'line' | 'endLine'> {
  readonly at: readonly string[];
}

/** A registry problem with a resolved URL; the caller names the package. */
interface Issue {
  readonly rule: Rule;
  readonly level: Level;
  readonly says: string;
}

export const npmSupplyChain: Plugin = {
  id: tool, version: '1.0.0', api: pluginApi,
  kinds: ['security'],
  claims: { globs: ['**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml'] },
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  rules: Object.entries(ruleDescriptions).map(([id, description]) => ({ id, category: 'dependency', description })),
  operations: [{
    id: 'scan', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
    execute(inputs): FindingResult {
      const { path, bytes } = inputs.read('source', sourceFile);
      if (path.split('/').includes('node_modules')) return { measurements: [], findings: [] };
      const name = path.slice(path.lastIndexOf('/') + 1);
      const text = new TextDecoder().decode(bytes);
      const hits = name === 'package.json' ? jsonHits(name, text, manifestHits)
        : name === 'package-lock.json' || name === 'npm-shrinkwrap.json' ? jsonHits(name, text, packageLockHits)
          : name === 'yarn.lock' ? yarnLockHits(text)
            : name === 'pnpm-lock.yaml' ? pnpmLockHits(text) : [];
      return { measurements: [], findings: capped(path, name, hits) };
    },
  }],
};

function capped(path: string, name: string, hits: readonly Hit[]): Finding[] {
  const byLine = [...hits].sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  const kept: Hit[] = [];
  const summaries: Finding[] = [];
  for (const rule of Object.keys(ruleDescriptions) as Rule[]) {
    const matching = byLine.filter(hit => hit.rule === rule);
    kept.push(...matching.slice(0, findingsPerRule));
    const rest = matching.slice(findingsPerRule);
    if (rest.length === 0) continue;
    const level = rest.reduce<Level>((worst, hit) => levelOrder.indexOf(hit.level) > levelOrder.indexOf(worst) ? hit.level : worst, 'low');
    summaries.push({ tool, rule, category: 'dependency', level, path,
      message: `${name} has ${matching.length} ${rule} findings; only the first ${findingsPerRule} are listed.` });
  }
  kept.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  return [...kept.map(({ rule, level, message, line, endLine }): Finding => ({ tool, rule, category: 'dependency', level, message, path,
    ...(line === undefined ? {} : { line, endLine: endLine ?? line }) })), ...summaries];
}

function jsonHits(name: string, text: string, analyse: (value: unknown) => JsonHit[]): Hit[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const found = analyse(value);
  if (found.length === 0) return [];
  const spans = locate(text, new Set(found.map(hit => pointer(hit.at))), Math.max(...found.map(hit => hit.at.length)));
  return found.map(({ at, ...hit }) => ({ ...hit, ...spans.get(pointer(at)) }));
}

function manifestHits(manifest: unknown): JsonHit[] {
  if (!isRecord(manifest)) return [];
  const hits: JsonHit[] = [];
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (!isRecord(dependencies)) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string') continue;
      const hit = specHit(name, spec.trim());
      if (hit) hits.push({ ...hit, at: [section, name] });
    }
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const owner = typeof manifest.name === 'string' && manifest.name !== '' ? `Package ${manifest.name}` : 'This package';
  for (const script of installScripts) {
    const command = scripts[script];
    if (typeof command !== 'string' || command.trim() === '') continue;
    hits.push({ rule: 'install-script', level: 'medium', at: ['scripts', script],
      message: `${owner} runs a ${script} script on every install: ${JSON.stringify(abbreviate(command.trim(), 80))}.` });
  }
  return hits;
}

function specHit(name: string, spec: string): Omit<JsonHit, 'at'> | undefined {
  const alias = /^npm:(?:@[^/@\s]+\/)?[^/@\s]+(?:@(.*))?$/.exec(spec);
  const range = alias ? (alias[1] ?? '').trim() : spec;
  if (range === '' || range === '*' || range === 'latest') {
    return { rule: 'dependency-unbounded', level: 'low',
      message: `Dependency ${name} accepts any version (${range === '' ? 'empty range' : JSON.stringify(range)}).` };
  }
  if (alias) return undefined;
  const shown = display(spec);
  const protocol = /^([a-z][a-z0-9+.-]*):\/\//i.exec(spec)?.[1]?.toLowerCase();
  if (protocol === 'http') {
    return { rule: 'dependency-from-url', level: 'high', message: `Dependency ${name} is downloaded over plain HTTP from ${shown}.` };
  }
  if (protocol === 'git' || protocol === 'git+http') {
    return { rule: 'dependency-from-url', level: 'high',
      message: `Dependency ${name} is fetched over unencrypted ${protocol}:// from ${shown}.` };
  }
  const git = protocol?.startsWith('git+') || /^(?:github|gitlab|bitbucket|gist):/i.test(spec)
    || /^[\w.-]+@[\w.-]+:(?!\/\/)/.test(spec) || isGitHubShorthand(spec)
    || (protocol === 'https' && (/\.git(?:#|$)/i.test(spec) || hostedRepository.test(spec)));
  const tarball = !git && protocol === 'https';
  if (!git && !tarball) return undefined;
  const commit = /#([0-9a-f]{40})$/i.exec(spec)?.[1]
    ?? (tarball ? /^[^?#]*\/([0-9a-f]{40})(?:\.(?:tar\.gz|tgz|zip))?(?:[/?#]|$)/i.exec(spec)?.[1] : undefined);
  if (commit) {
    return { rule: 'dependency-from-url', level: 'low',
      message: `Dependency ${name} bypasses the registry but is pinned to commit ${commit.slice(0, 12)} of ${shown}.` };
  }
  if (tarball && registryHosts.has(host(spec))) {
    return { rule: 'dependency-from-url', level: 'low',
      message: `Dependency ${name} names a registry tarball URL instead of a version range: ${shown}.` };
  }
  return { rule: 'dependency-from-url', level: 'high',
    message: `Dependency ${name} follows ${git ? 'git source' : 'remote tarball'} ${shown} without a pinned commit.` };
}

/** npm reads `owner/repo` and `owner/repo#ref` as GitHub repositories; paths start with `.`, `/` or `~/`. */
function isGitHubShorthand(spec: string): boolean {
  return /^(?![.~])[^\s@:/#\\]+\/[^\s@:/#\\]+(?:#\S*)?$/.test(spec);
}

function packageLockHits(lock: unknown): JsonHit[] {
  if (!isRecord(lock) || !isRecord(lock.packages)) return [];
  const hits: JsonHit[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || !isRecord(entry) || entry.link === true || typeof entry.resolved !== 'string') continue;
    const marker = key.lastIndexOf('node_modules/');
    const name = marker < 0 ? key : key.slice(marker + 'node_modules/'.length);
    for (const { rule, level, says } of registryIssues(entry.resolved)) {
      hits.push({ rule, level, message: `Package ${name} ${says}.`, at: ['packages', key, 'resolved'] });
    }
    const protocol = /^([a-z]+):\/\//i.exec(entry.resolved)?.[1]?.toLowerCase();
    if ((protocol === 'https' || protocol === 'http') && (typeof entry.integrity !== 'string' || entry.integrity.trim() === '')) {
      hits.push({ rule: 'lockfile-missing-integrity', level: 'medium', at: ['packages', key],
        message: `Package ${name} resolves from ${host(entry.resolved)} without an integrity hash.` });
    }
  }
  return hits;
}

function yarnLockHits(text: string): Hit[] {
  const hits: Hit[] = [];
  let name: string | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      name = line.endsWith(':') && !line.startsWith('__metadata') ? selectorName(line.slice(0, -1)) : undefined;
      continue;
    }
    const field = name === undefined ? null : /^ {2}(?:resolved|resolution:)\s+(.+?)\s*$/.exec(line);
    const url = field ? urlIn(unquote(field[1]!)) : undefined;
    if (url === undefined) continue;
    for (const { rule, level, says } of registryIssues(url)) {
      hits.push({ rule, level, message: `Package ${name} ${says}.`, line: index + 1 });
    }
  }
  return hits;
}

/** The package name of a yarn.lock entry header such as `"@scope/name@^1.0.0", "@scope/name@^1.1.0"`. */
function selectorName(header: string): string {
  const first = unquote(header.split(',')[0]!.trim());
  const at = first.indexOf('@', 1);
  return at > 0 ? first.slice(0, at) : first;
}

function pnpmLockHits(text: string): Hit[] {
  const hits: Hit[] = [];
  let section = '';
  let entry: { name: string; issues: (Issue & { line: number })[] } | undefined;
  let block = false;
  const flush = (): void => {
    for (const { rule, level, says, line } of entry?.issues ?? []) {
      hits.push({ rule, level, message: `Package ${entry!.name} ${says}.`, line });
    }
    entry = undefined;
  };
  const check = (value: string, line: number): void => {
    const url = urlIn(unquote(value.trim()));
    if (!entry || url === undefined) return;
    for (const issue of registryIssues(url)) {
      if (!entry.issues.some(known => known.rule === issue.rule)) entry.issues.push({ ...issue, line });
    }
  };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      flush();
      section = line.slice(0, Math.max(0, line.indexOf(':')));
      continue;
    }
    if (section !== 'packages') continue;
    const header = /^ {2}(\S.*?):\s*$/.exec(line);
    if (header) {
      flush();
      entry = { name: pnpmName(unquote(header[1]!)), issues: [] };
      block = false;
      continue;
    }
    if (block) {
      const nested = /^ {6,}[\w-]+:\s*(.+)$/.exec(line);
      if (nested) {
        check(nested[1]!, index + 1);
        continue;
      }
      block = false;
    }
    const named = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (named && entry) entry.name = unquote(named[1]!);
    const inline = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line);
    for (const pair of inline ? inline[1]!.split(/,\s*/) : []) check(pair.slice(pair.indexOf(':') + 1), index + 1);
    if (/^ {4}resolution:\s*$/.test(line)) block = true;
  }
  flush();
  return hits;
}

/** The package name in a pnpm `packages` key: `/name/1.0.0` (v5), `/name@1.0.0` (v6) or `name@1.0.0(peer)` (v9). */
function pnpmName(key: string): string {
  const [first = '', second = ''] = key.replace(/^\//, '').split('/');
  const bare = (segment: string): string => segment.replace(/[@(].*$/, '');
  return first.startsWith('@') ? `${first}/${bare(second)}` : bare(first);
}

function registryIssues(url: string): Issue[] {
  const protocol = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  const where = host(url);
  if (protocol === undefined || where === '' || protocol.endsWith('file')) return [];
  const issues: Issue[] = [];
  if (insecureProtocols.has(protocol)) {
    issues.push({ rule: 'lockfile-insecure-registry', level: 'high', says: `is downloaded over unencrypted ${protocol}:// from ${where}` });
  }
  if (!registryHosts.has(where)) {
    issues.push({ rule: 'lockfile-foreign-host', level: 'medium', says: `resolves from ${where} instead of the npm registry` });
  }
  return issues;
}

function host(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(url)?.[1]?.toLowerCase() ?? '';
}

function urlIn(value: string): string | undefined {
  return /[a-z][a-z0-9+.-]*:\/\/\S+/i.exec(value)?.[0];
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** A URL fit for a report: no credentials, no query string, bounded length. */
function display(url: string): string {
  return abbreviate(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1').replace(/\?[^#]*/, ''), 100);
}

function abbreviate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function pointer(path: readonly string[]): string {
  return path.map(segment => JSON.stringify(segment)).join('');
}

interface Span {
  readonly line: number;
  readonly endLine: number;
}

interface Frame {
  readonly path: string | undefined;
  readonly line: number;
  readonly array: boolean;
  index: number;
  key: string;
  keyLine: number;
  expectKey: boolean;
}

/**
 * Find the lines of the wanted values in JSON text that JSON.parse has already accepted. A member starts on the line
 * of its key and ends on the line where its value ends. Only paths up to `depth` keys deep are tracked.
 */
function locate(text: string, wanted: ReadonlySet<string>, depth: number): ReadonlyMap<string, Span> {
  const spans = new Map<string, Span>();
  const stack: Frame[] = [];
  let line = 1;
  const child = (): { path: string | undefined; line: number } => {
    const parent = stack.at(-1);
    if (!parent) return { path: '', line };
    const path = parent.path === undefined || stack.length > depth ? undefined
      : parent.path + (parent.array ? `#${parent.index}` : JSON.stringify(parent.key));
    return { path, line: parent.array ? line : parent.keyLine };
  };
  const scalar = (): void => {
    const { path, line: start } = child();
    if (path !== undefined && wanted.has(path)) spans.set(path, { line: start, endLine: line });
  };
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === '\n') line++;
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r' || char === ':') {
      index++;
    } else if (char === ',') {
      const parent = stack.at(-1);
      if (parent?.array) parent.index++;
      else if (parent) parent.expectKey = true;
      index++;
    } else if (char === '"') {
      const end = stringEnd(text, index);
      const parent = stack.at(-1);
      if (parent && !parent.array && parent.expectKey) {
        const raw = text.slice(index + 1, end);
        parent.key = raw.includes('\\') ? JSON.parse(text.slice(index, end + 1)) as string : raw;
        parent.keyLine = line;
        parent.expectKey = false;
      } else {
        scalar();
      }
      index = end + 1;
    } else if (char === '{' || char === '[') {
      const { path, line: start } = child();
      stack.push({ path, line: start, array: char === '[', index: 0, key: '', keyLine: line, expectKey: char === '{' });
      index++;
    } else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (frame?.path !== undefined && wanted.has(frame.path)) spans.set(frame.path, { line: frame.line, endLine: line });
      index++;
    } else {
      scalar();
      while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index++;
    }
  }
  return spans;
}

function stringEnd(text: string, start: number): number {
  for (let from = start + 1; ;) {
    const quote = text.indexOf('"', from);
    if (quote < 0) return text.length;
    let slashes = 0;
    while (text[quote - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 0) return quote;
    from = quote + 1;
  }
}
