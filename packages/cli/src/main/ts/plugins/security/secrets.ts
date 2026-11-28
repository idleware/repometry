import { isRecord, pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin, RuleDescriptor } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { Finding, FindingResult } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';

/** A line that contains this marker is never reported. */
export const ignoreMarker = 'repometry-ignore-secret';
/** Files larger than this are not scanned. */
export const maxScannedBytes = 1024 * 1024;
/** A NUL byte within this prefix marks the file as binary. */
const binaryProbeBytes = 8 * 1024;
/** How much text after a private key header may hold its body and footer. */
const privateKeyLines = 400;
const privateKeyChars = 64 * 1024;

type Level = 'high' | 'medium';

interface LineContext {
  readonly lines: readonly string[];
  readonly index: number;
}

interface LineRule {
  readonly id: string;
  readonly level: Level;
  readonly message: string;
  readonly description: string;
  /** Cheap test a line must pass before the pattern runs. */
  readonly hint: RegExp;
  /** Global pattern; the first defined capture group is the secret body checked by the default acceptance. */
  readonly pattern: RegExp;
  readonly accept: (match: RegExpMatchArray, context: LineContext) => boolean;
}

const skipped = `lines containing ${ignoreMarker} are skipped`;

const placeholder = new RegExp([
  'example', 'dummy', 'change[_-]?me', 'placeholder', 'sample', 'redacted', 'fake', 'your[_-]', 'x{3,}', '\\*{3,}', '\\.{3}',
  '<[^>]*>', '\\$\\{', '\\{\\{', '%\\(', '^\\$[A-Za-z_]\\w*$', 'process\\.env', 'os\\.environ', '(.)\\1{5,}',
].join('|'), 'i');

export function isPlaceholder(value: string): boolean {
  return placeholder.test(value);
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / value.length) * Math.log2(count / value.length);
  return entropy;
}

function body(match: RegExpMatchArray): string {
  return match.slice(1).find(group => group !== undefined) ?? match[0];
}

function random(value: string, minimumEntropy: number): boolean {
  return !isPlaceholder(value) && shannonEntropy(value) >= minimumEntropy;
}

function token(minimumEntropy: number): LineRule['accept'] {
  return match => random(body(match), minimumEntropy);
}

function awsSecret(match: RegExpMatchArray): boolean {
  const value = body(match);
  return /[A-Z]/.test(value) && /[a-z]/.test(value) && random(value, 4);
}

const privateKeyFooter = /-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/;
const keyBodyPlaceholder = /example|redacted|placeholder|dummy|x{6,}|\.{3}/i;

/** A real key has a footer and at least one line of base64 between header and footer, raw or inside a quoted string. */
function hasKeyBody(match: RegExpMatchArray, { lines, index }: LineContext): boolean {
  let text = lines[index]!.slice((match.index ?? 0) + match[0].length);
  for (let next = index + 1; next < Math.min(lines.length, index + privateKeyLines) && text.length < privateKeyChars; next++) {
    text += '\n' + lines[next]!;
  }
  const footer = privateKeyFooter.exec(text);
  if (footer === null) return false;
  const content = text.slice(0, footer.index);
  return !keyBodyPlaceholder.test(content) && content.split(/\s+|\\[nr]/)
    .some(part => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(part.replace(/^['"`+,]+|['"`+,]+$/g, '')));
}

function isJwt(match: RegExpMatchArray): boolean {
  if (isPlaceholder(match[2]!)) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8'));
    return isRecord(header) && typeof header.alg === 'string';
  } catch {
    return false;
  }
}

const lineRules: readonly LineRule[] = [
  { id: 'aws-access-key-id', level: 'high', message: 'Hard-coded AWS access key ID',
    description: `Flags AWS access key IDs (AKIA or ASIA followed by 16 base32 characters); ${skipped}.`,
    hint: /A[KS]IA/, pattern: /(?<![A-Za-z0-9])((?:AKIA|ASIA)[A-Z2-7]{16})(?![A-Za-z0-9])/g, accept: token(3) },
  { id: 'aws-secret-access-key', level: 'high', message: 'Hard-coded AWS secret access key',
    description: `Flags a 40-character base64 value assigned to an AWS secret access key name; ${skipped}.`, hint: /secret/i,
    pattern: /(?:(?:aws[_.-]?)?secret[_.-]?access[_.-]?key|aws[_.-]?secret(?:[_.-]?key)?)["']?\s*(?::=|=>|[:=])\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    accept: awsSecret },
  { id: 'github-token', level: 'high', message: 'Hard-coded GitHub token',
    description: `Flags GitHub personal access, OAuth, user, server and refresh tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_); ${skipped}.`,
    hint: /gh[pousr]_|github_pat_/, pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_([A-Za-z0-9]{36})|github_pat_(\w{82}))(?![A-Za-z0-9_])/g,
    accept: token(3.5) },
  { id: 'gitlab-token', level: 'high', message: 'Hard-coded GitLab personal access token',
    description: `Flags GitLab personal access tokens (glpat- followed by at least 20 characters); ${skipped}.`,
    hint: /glpat-/, pattern: /(?<![\w-])glpat-([\w-]{20,})(?![\w-])/g, accept: token(3) },
  { id: 'slack-token', level: 'high', message: 'Hard-coded Slack token',
    description: `Flags Slack bot, user, app, refresh and legacy tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-); ${skipped}.`,
    hint: /xox[baprs]-/, pattern: /(?<![\w-])xox[baprs]-(\d{1,13}-[0-9A-Za-z-]{8,})/g, accept: token(3) },
  { id: 'slack-webhook', level: 'high', message: 'Hard-coded Slack webhook URL',
    description: `Flags Slack incoming webhook, workflow and trigger URLs on hooks.slack.com; ${skipped}.`, hint: /hooks\.slack\.com/,
    pattern: /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/]{43,56})/g, accept: token(3.5) },
  { id: 'stripe-secret-key', level: 'high', message: 'Hard-coded Stripe live secret key',
    description: `Flags Stripe live secret and restricted keys (sk_live_, rk_live_); test and publishable keys are ignored; ${skipped}.`,
    hint: /k_live_/, pattern: /(?<![\w])[rs]k_live_([0-9A-Za-z]{24,247})(?![0-9A-Za-z])/g, accept: token(3.5) },
  { id: 'google-api-key', level: 'medium', message: 'Hard-coded Google API key',
    description: `Flags Google API keys (AIza followed by 35 characters), often meant for clients but still worth restricting; ${skipped}.`,
    hint: /AIza/, pattern: /(?<![\w-])AIza([0-9A-Za-z_-]{35})(?![\w-])/g, accept: token(3.5) },
  { id: 'npm-token', level: 'high', message: 'Hard-coded npm access token',
    description: `Flags npm access tokens (npm_ followed by 36 characters); ${skipped}.`,
    hint: /npm_/, pattern: /(?<![\w])npm_([A-Za-z0-9]{36})(?![\w])/g, accept: token(3.5) },
  { id: 'private-key', level: 'high', message: 'Hard-coded private key',
    description: `Flags PEM, OpenSSH and PGP private key blocks that have a base64 body and a footer; ${skipped}.`,
    hint: /-----BEGIN/, pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g, accept: hasKeyBody },
  { id: 'jwt', level: 'medium', message: 'Hard-coded JSON Web Token',
    description: `Flags JSON Web Tokens whose first segment decodes to a JSON header with an alg field; ${skipped}.`,
    hint: /eyJ/, pattern: /(?<![\w-])(eyJ[A-Za-z0-9_-]{8,})\.eyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{16,})/g, accept: isJwt },
];

/** Name, optional type annotation, assignment operator and a quoted literal without whitespace. */
const assignment = /(?<![\w$-])(["'`]?)([A-Za-z_$][\w$-]*)\1(?:\s*:\s*[A-Za-z_$][\w$.<>]*)?\s*(?::=|=>|[:=])\s*(["'`])([^\s"'`\\]{16,})\3/g;
const keyQualifiers = new Set(['secret', 'access', 'private', 'auth', 'signing', 'encryption', 'master']);

function credentialKind(name: string): string | undefined {
  const words = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
  const last = words.at(-1);
  const previous = words.at(-2);
  if (last === 'password' || last === 'passwd' || last === 'pwd' || last === 'passphrase') return 'password';
  if (last === 'secret' || last === 'token') return last;
  if (last === 'apikey' || (last === 'key' && previous === 'api')) return 'API key';
  if (last === 'key' && previous !== undefined && keyQualifiers.has(previous)) return 'secret key';
  return undefined;
}

/** Paths, URLs and dotted, dashed or underscored words are names, not secrets. */
function looksLikeName(value: string): boolean {
  const parts = value.split(/[._-]/);
  return /^(?:\.{0,2}\/|~\/|[a-z][\w+.-]*:\/\/)/i.test(value) || (parts.length > 1 && parts.every(part => /^[A-Za-z]*\d*$/.test(part)));
}

/** A letter and a non-letter rule out plain and camel-cased words; hex has a smaller alphabet, so a lower entropy bar. */
function looksSecret(value: string): boolean {
  return /[A-Za-z]/.test(value) && /[^A-Za-z]/.test(value) && !looksLikeName(value)
    && random(value, /^[\dA-Fa-f-]+$/.test(value) ? 3 : 3.5);
}

function assignedSecret(line: string, claimed: readonly (readonly [number, number])[]): string | undefined {
  for (const match of line.matchAll(assignment)) {
    const value = match[4]!;
    const end = (match.index ?? 0) + match[0].length - 1;
    if (claimed.some(([from, to]) => end - value.length < to && from < end)) continue;
    const kind = credentialKind(match[2]!);
    if (kind !== undefined && looksSecret(value)) return kind;
  }
  return undefined;
}

const genericRule: RuleDescriptor = { id: 'generic-secret-assignment', category: 'secret',
  description: 'Flags a quoted high-entropy literal of 16 or more characters assigned to a password, secret, token or API key name, '
    + `ignoring placeholders such as example, dummy, changeme, xxx, \${...} and process.env; ${skipped}.` };

const sensitiveRule: RuleDescriptor = { id: 'sensitive-file', category: 'secret',
  description: 'Flags files that usually hold credentials: .env and .env.* except .env.example, .env.sample and .env.template, '
    + '*.pem and *.key unless they hold only public certificates or keys, *.p12, *.pfx, id_rsa, id_dsa, id_ecdsa, id_ed25519, '
    + `.git-credentials, and .npmrc or .pypirc with a literal auth token; ${ignoreMarker} on the first line skips the file.` };

export const secretRules: readonly RuleDescriptor[] = [
  ...lineRules.map(({ id, description }) => ({ id, category: 'secret', description })), genericRule, sensitiveRule,
];

const sshKeys = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const envTemplates = new Set(['example', 'sample', 'template']);
const publicPem = /^(?:(?:TRUSTED |X509 )?CERTIFICATE|(?:NEW )?CERTIFICATE REQUEST|X509 CRL|(?:RSA |SSH2 )?PUBLIC KEY|PKCS7|CMS|(?:DH|EC) PARAMETERS)$/;
const npmAuth = /(?:^|:)_(?:authToken|auth|password)\s*=\s*["']?([^\s"']+)/;
const pypiPassword = /^\s*password\s*[:=]\s*(\S+)/i;

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function onlyPublicPem(lines: readonly string[]): boolean {
  const labels = lines.flatMap(line => [...line.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----/g)].map(match => match[1]!));
  return labels.length > 0 && labels.every(label => publicPem.test(label));
}

function hasLiteral(lines: readonly string[], pattern: RegExp): boolean {
  return lines.some(line => {
    if (line.includes(ignoreMarker) || /^\s*[#;]/.test(line)) return false;
    const value = pattern.exec(line)?.[1];
    return value !== undefined && !isPlaceholder(value);
  });
}

function keystoreKind(name: string): string | undefined {
  return extension(name) === '.p12' || extension(name) === '.pfx' ? 'PKCS#12 keystore' : undefined;
}

function sensitiveTextKind(name: string, lines: readonly string[]): string | undefined {
  if (name === '.env' || (name.startsWith('.env.') && !envTemplates.has(name.slice(5).toLowerCase()))) return 'environment file';
  if ((extension(name) === '.pem' || extension(name) === '.key') && !onlyPublicPem(lines)) return 'key file';
  if (sshKeys.has(name)) return 'SSH private key file';
  if (name === '.git-credentials') return 'Git credential store';
  if (name === '.npmrc' && hasLiteral(lines, npmAuth)) return 'npm configuration with an auth token';
  if (name === '.pypirc' && hasLiteral(lines, pypiPassword)) return 'PyPI configuration with a password';
  return undefined;
}

function finding(rule: string, level: Level, message: string, path: string, line: number): Finding {
  return { tool: 'secrets', rule, category: 'secret', level, message, path, line, endLine: line };
}

function lineFindings(path: string, context: LineContext): Finding[] {
  const line = context.lines[context.index]!;
  const claimed: (readonly [number, number])[] = [];
  const findings: Finding[] = [];
  for (const rule of lineRules) {
    if (!rule.hint.test(line)) continue;
    for (const match of line.matchAll(rule.pattern)) {
      if (!rule.accept(match, context)) continue;
      claimed.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
      if (!findings.some(item => item.rule === rule.id)) findings.push(finding(rule.id, rule.level, rule.message, path, context.index + 1));
    }
  }
  const kind = /pass|pwd|secret|token|key/i.test(line) ? assignedSecret(line, claimed) : undefined;
  if (kind !== undefined) findings.push(finding(genericRule.id, 'medium', `Likely hard-coded ${kind}`, path, context.index + 1));
  return findings;
}

/** Scans one file. Secret values never reach a finding: messages name only the kind of secret. */
export function scanSecrets(path: string, bytes: Uint8Array): Finding[] {
  if (bytes.length > maxScannedBytes) return [];
  const name = path.slice(path.lastIndexOf('/') + 1);
  const file = (kind: string) => finding(sensitiveRule.id, 'medium', `Sensitive file: ${kind}`, path, 1);
  if (bytes.subarray(0, binaryProbeBytes).includes(0)) {
    const kind = keystoreKind(name);
    return kind === undefined ? [] : [file(kind)];
  }
  const lines = new TextDecoder().decode(bytes).split(/\r\n|\r|\n/);
  const findings: Finding[] = [];
  const kind = keystoreKind(name) ?? sensitiveTextKind(name, lines);
  if (kind !== undefined && !lines[0]!.includes(ignoreMarker)) findings.push(file(kind));
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.includes(ignoreMarker)) findings.push(...lineFindings(path, { lines, index }));
  }
  return findings;
}

export const secrets: Plugin = {
  id: 'secrets', version: '1.0.0', api: pluginApi,
  kinds: ['security'],
  // `**/*` skips dotfiles, so `**/.*` adds .env, .npmrc and files under dot directories.
  claims: { globs: ['**/*', '**/.*'], scanOnly: true },
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  rules: secretRules,
  operations: [{
    id: 'scan', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
    execute(inputs): FindingResult {
      const { path, bytes } = inputs.read('source', sourceFile);
      return { measurements: [], findings: scanSecrets(path, bytes) };
    },
  }],
};
