import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { Finding, FindingResult } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';

const rules = {
  'unpinned-base-image': { level: 'medium',
    description: 'A FROM image has no tag or uses latest and is not pinned by digest, so rebuilds can silently change the base.' },
  'runs-as-root': { level: 'medium',
    description: 'The final stage sets no USER or switches back to root, so the container runs as root.' },
  'remote-add': { level: 'medium',
    description: 'ADD downloads a remote URL without checksum verification instead of curl with a checksum or COPY.' },
  'pipe-to-shell': { level: 'high',
    description: 'A RUN step pipes a curl or wget download straight into a shell, executing unverified remote code.' },
  'secret-in-env': { level: 'high',
    description: 'An ENV or ARG with a secret-looking name carries a literal value that is stored in the image or its history.' },
  'apt-unpinned-upgrade': { level: 'low',
    description: 'A RUN step runs apt-get upgrade or dist-upgrade, so the image contents depend on the day it was built.' },
  'sudo-usage': { level: 'low',
    description: 'A RUN step uses sudo, which is unnecessary during builds and behaves unpredictably in containers.' },
} as const satisfies Readonly<Record<string, { readonly level: Finding['level']; readonly description: string }>>;

type Rule = keyof typeof rules;

interface Instruction {
  /** Upper-cased instruction name. */
  readonly keyword: string;
  /** Arguments with line continuations joined and continued comment lines removed. */
  readonly args: string;
  readonly line: number;
  readonly endLine: number;
  /** Heredoc bodies in the order of their markers. */
  readonly heredocs: readonly string[];
}

interface Stage {
  readonly from: Instruction;
  /** The expanded external image, or undefined for stage references and unresolved variables. */
  readonly image: string | undefined;
  readonly parent: number | undefined;
  readonly users: Instruction[];
}

const directive = /^#[ \t]*([A-Za-z][A-Za-z0-9]*)[ \t]*=[ \t]*(.+?)[ \t]*$/;
const directives = new Set(['syntax', 'escape', 'check']);
const heredocInstructions = new Set(['ADD', 'COPY', 'RUN']);
const shells = new Set(['sh', 'bash', 'zsh', 'ksh', 'mksh', 'dash', 'ash', 'fish', 'csh', 'tcsh']);
const prefixes = new Set(['!', '{', 'command', 'do', 'elif', 'else', 'env', 'exec', 'if', 'nice', 'nohup', 'sudo', 'then', 'time', 'until', 'while']);
const prefixOptionsWithValues = new Set(['-C', '-D', '-S', '-T', '-U', '-g', '-h', '-n', '-p', '-r', '-t', '-u']);
const aptOptionsWithValues = new Set(['-c', '-o', '-t', '--config-file', '--option', '--target-release']);
const upgrades = new Set(['upgrade', 'dist-upgrade', 'full-upgrade']);
const substitutedDownload = /(?:^|[\s;&|(])(?:\S*\/)?(?:a|ba|da|k|z)?sh\s+(?:-\w+\s+)*["']?(?:\$\(|<\(|`)\s*(?:curl|wget)\b/;
const secretName = /_(?:[A-Z0-9]*PASS(?:WORD|WD)S?|[A-Z0-9]*SECRETS?|[A-Z0-9]*TOKENS?|API_?KEYS?|PRIVATE_?KEYS?|ACCESS_?KEYS?)_/;
const qualifiers = new Set(['DIR', 'ENABLED', 'ENDPOINT', 'EXPIRES', 'EXPIRY', 'FILE', 'FORMAT', 'HEADER', 'HOST', 'LEN', 'LENGTH',
  'LIFETIME', 'MODE', 'NAME', 'PATH', 'POLICY', 'PORT', 'REQUIRED', 'SIZE', 'TIMEOUT', 'TTL', 'TYPE', 'URI', 'URL', 'USER',
  'USERNAME', 'VERSION']);

export const dockerfile: Plugin = {
  id: 'dockerfile', version: '1.0.0', api: pluginApi,
  kinds: ['security'],
  claims: { globs: ['**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/Containerfile'] },
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  rules: Object.entries(rules).map(([id, { description }]) => ({ id, category: 'infrastructure', description })),
  operations: [{
    id: 'scan', role: 'inspection', inputs: { source: sourceFile }, output: findingResult,
    execute(inputs): FindingResult {
      const { path, bytes } = inputs.read('source', sourceFile);
      if (bytes.includes(0)) return { measurements: [], findings: [] };
      return { measurements: [], findings: scan(path, new TextDecoder().decode(bytes)) };
    },
  }],
};

function scan(path: string, text: string): Finding[] {
  const { escape, instructions } = parseDockerfile(text);
  const findings: Finding[] = [];
  const report = (rule: Rule, at: Instruction, message: string): void => {
    findings.push({ tool: 'dockerfile', category: 'infrastructure', rule, level: rules[rule].level, message, path,
      line: at.line, endLine: at.endLine });
  };
  const globals = new Map<string, string | undefined>();
  const stages: Stage[] = [];
  const names = new Map<string, number>();

  for (const instruction of instructions) {
    const { keyword } = instruction;
    if (keyword === 'FROM') {
      startStage(instruction);
    } else if (keyword === 'USER') {
      stages.at(-1)?.users.push(instruction);
    } else if (keyword === 'ENV' || keyword === 'ARG') {
      for (const { name, value } of variables(instruction, escape)) {
        if (keyword === 'ARG' && stages.length === 0) globals.set(name, value);
        if (!isSecretName(name) || !isLiteral(value)) continue;
        report('secret-in-env', instruction, keyword === 'ENV'
          ? `ENV ${name} sets a literal secret value that is stored in the image; inject it at runtime or with a build secret instead.`
          : `ARG ${name} has a literal default secret value that is recorded in the image history; pass it with a build secret instead.`);
      }
    } else if (keyword === 'ADD') {
      if (isRemoteAdd(instruction.args, escape)) {
        report('remote-add', instruction,
          'ADD downloads a remote URL without checksum verification; fetch it with curl and verify a checksum, or COPY a local file.');
      }
    } else if (keyword === 'RUN') {
      checkRun(instruction);
    }
  }

  checkFinalStage();
  return findings.sort((left, right) => left.line! - right.line! || left.endLine! - right.endLine!
    || left.rule.localeCompare(right.rule));

  function startStage(instruction: Instruction): void {
    const [reference = '', as, name] = words(instruction.args, escape).filter(item => !item.startsWith('--'));
    const image = expand(reference, globals);
    const parent = names.get((image ?? reference).toLowerCase());
    if (parent === undefined && image !== undefined && image.toLowerCase() !== 'scratch') {
      const pinning = pinningOf(image);
      if (pinning === 'none') {
        report('unpinned-base-image', instruction,
          `Base image ${image} has no tag or digest, so every build pulls whatever latest points to; pin a version tag or a digest.`);
      } else if (pinning === 'latest') {
        report('unpinned-base-image', instruction, `Base image ${image} uses the mutable latest tag; pin a version tag or a digest.`);
      }
    }
    stages.push({ from: instruction, image: parent === undefined ? image : undefined, parent, users: [] });
    if (as?.toUpperCase() === 'AS' && name) names.set(name.toLowerCase(), stages.length - 1);
  }

  function checkRun(instruction: Instruction): void {
    const script = runScript(instruction);
    const commands = pipelines(script);
    const steps = commands.flat();
    if (substitutedDownload.test(script) || commands.some(pipesDownloadToShell)) {
      report('pipe-to-shell', instruction,
        'RUN pipes a curl or wget download straight into a shell; download to a file and verify its checksum before running it.');
    }
    if (steps.some(upgradesAllPackages)) {
      report('apt-unpinned-upgrade', instruction,
        'RUN upgrades every installed package with apt, which makes the build unreproducible; use a newer base image or pin packages.');
    }
    if (steps.some(item => command(item).sudo)) {
      report('sudo-usage', instruction,
        'RUN uses sudo, which behaves unpredictably in containers; run the step before switching USER or use gosu instead.');
    }
  }

  function checkFinalStage(): void {
    const final = stages.at(-1);
    if (final === undefined) return;
    const { user, image } = effectiveUser(stages, stages.length - 1);
    if (user === undefined) {
      if (image === undefined || !/nonroot/i.test(image)) report('runs-as-root', final.from,
        'The final stage never sets USER, so the container runs as root; add a USER with an unprivileged account.');
      return;
    }
    const account = (words(user.args, escape)[0] ?? '').split(':')[0];
    if (account === 'root' || account === '0') report('runs-as-root', user,
      'The final stage runs as root because its last USER is root; switch to an unprivileged user.');
  }
}

function parseDockerfile(text: string): { readonly escape: string; readonly instructions: readonly Instruction[] } {
  const lines = text.split(/\r\n|\r|\n/);
  const escape = escapeOf(lines);
  const continuation = new RegExp(`${escape === '`' ? '`' : '\\\\'}[ \\t]*$`);
  const instructions: Instruction[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isIgnorable(lines[index]!)) {
      index++;
      continue;
    }
    const start = index;
    let end = index;
    let logical = '';
    for (;;) {
      const physical = lines[end]!;
      const match = continuation.exec(physical);
      if (match === null) {
        logical += physical;
        break;
      }
      logical += physical.slice(0, match.index);
      let next = end + 1;
      while (next < lines.length && isIgnorable(lines[next]!)) next++;
      if (next >= lines.length) break;
      end = next;
    }
    index = end + 1;
    const match = /^\s*(\S+)\s*(.*)$/s.exec(logical);
    if (match === null) continue;
    const keyword = match[1]!.toUpperCase();
    const args = match[2]!.trim();
    const heredocs: string[] = [];
    if (heredocInstructions.has(keyword)) {
      for (const { name, chomp } of heredocMarkers(args)) {
        const body: string[] = [];
        while (index < lines.length) {
          const line = chomp ? lines[index]!.replace(/^\t+/, '') : lines[index]!;
          end = index++;
          if (line === name) break;
          body.push(line);
        }
        heredocs.push(body.join('\n'));
      }
    }
    instructions.push({ keyword, args, line: start + 1, endLine: end + 1, heredocs });
  }
  return { escape, instructions };
}

/** Parser directives are only read from the leading comment lines, before any blank line, comment or instruction. */
function escapeOf(lines: readonly string[]): string {
  let escape = '\\';
  for (const line of lines) {
    const match = directive.exec(line.trim());
    if (match === null || !directives.has(match[1]!.toLowerCase())) break;
    if (match[1]!.toLowerCase() === 'escape' && (match[2] === '`' || match[2] === '\\')) escape = match[2];
  }
  return escape;
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** Heredoc markers start a word, as in BuildKit: `<<EOF`, `<<-EOF` or `<<"EOF"`, but not `<<<` or a quoted `"<<EOF"`. */
function heredocMarkers(args: string): { readonly name: string; readonly chomp: boolean }[] {
  return rawWords(args).flatMap(word => {
    const match = /^\d*<<(-?)([^<]+)$/.exec(word);
    const name = match?.[2]!.replace(/["'\\]/g, '');
    return match && name ? [{ name, chomp: match[1] === '-' }] : [];
  });
}

/** Split on unquoted whitespace and keep quotes and escapes as written. */
function rawWords(text: string): string[] {
  const result: string[] = [];
  let word = '';
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === '' && /\s/.test(char)) {
      if (word !== '') result.push(word);
      word = '';
      continue;
    }
    word += char;
    if (quote === '' && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = '';
    else if (char === '\\' && quote !== "'" && index + 1 < text.length) word += text[++index];
  }
  if (word !== '') result.push(word);
  return result;
}

/** Split Dockerfile arguments into words with quotes removed and the escape character applied. */
function words(text: string, escape: string): string[] {
  const result: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === escape && ['"', '$', escape].includes(text[index + 1] ?? '')) word += text[++index];
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) result.push(word);
      word = '';
      started = false;
    } else {
      started = true;
      if (char === '"' || char === "'") quote = char;
      else if (char === escape && index + 1 < text.length) word += text[++index];
      else word += char;
    }
  }
  if (started) result.push(word);
  return result;
}

function variables(instruction: Instruction, escape: string): { readonly name: string; readonly value: string | undefined }[] {
  const items = words(instruction.args, escape);
  if (instruction.keyword === 'ENV' && items[0] !== undefined && !items[0].includes('=')) {
    const rest = instruction.args.replace(/^\S+\s*/, '');
    return [{ name: items[0], value: rest === '' ? undefined : words(rest, escape).join(' ') }];
  }
  return items.map(item => {
    const at = item.indexOf('=');
    return at < 0 ? { name: item, value: undefined } : { name: item.slice(0, at), value: item.slice(at + 1) };
  });
}

function isSecretName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const last = normalized.slice(normalized.lastIndexOf('_') + 1);
  return secretName.test(`_${normalized}_`) && !qualifiers.has(last);
}

/** A literal value is non-empty and does not merely pass a build argument or another variable through. */
function isLiteral(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && !/\$(?:\{|[A-Za-z_])/.test(value);
}

/** Expand `$NAME`, `${NAME}`, `${NAME:-word}` and `${NAME:+word}` from global ARG defaults; unresolved references yield undefined. */
function expand(text: string, values: ReadonlyMap<string, string | undefined>): string | undefined {
  let resolved = true;
  const result = text.replace(/\$(?:\{([A-Za-z_]\w*)(?::([-+])([^}]*))?\}|([A-Za-z_]\w*))/g,
    (_: string, braced: string | undefined, operator: string | undefined, word: string | undefined, bare: string | undefined) => {
      const value = values.get(braced ?? bare ?? '');
      if (operator === '-') return value || (word ?? '');
      if (value === undefined) resolved = false;
      return operator === '+' ? (value ? word ?? '' : '') : value ?? '';
    });
  return resolved && result !== '' && !result.includes('$') ? result : undefined;
}

function pinningOf(image: string): 'digest' | 'tag' | 'latest' | 'none' {
  if (/@[a-z0-9]+:[0-9a-f]+$/i.test(image)) return 'digest';
  const name = image.split('@')[0]!;
  const last = name.slice(name.lastIndexOf('/') + 1);
  const colon = last.indexOf(':');
  if (colon < 0) return 'none';
  return last.slice(colon + 1) === 'latest' ? 'latest' : 'tag';
}

function effectiveUser(stages: readonly Stage[], index: number): { readonly user?: Instruction; readonly image?: string } {
  const stage = stages[index]!;
  const user = stage.users.at(-1);
  if (user !== undefined) return { user };
  if (stage.parent !== undefined) return effectiveUser(stages, stage.parent);
  return stage.image === undefined ? {} : { image: stage.image };
}

function isRemoteAdd(args: string, escape: string): boolean {
  const flags = rawWords(args);
  const firstSource = flags.findIndex(word => !word.startsWith('--'));
  if (flags.slice(0, firstSource < 0 ? flags.length : firstSource).some(flag => flag.startsWith('--checksum'))) return false;
  const rest = args.replace(/^(?:--\S+\s+)*/, '');
  const items = (rest.startsWith('[') ? jsonArray(rest) : undefined) ?? words(rest, escape);
  return items.slice(0, -1).some(source => /^https?:\/\//i.test(source));
}

/** The shell script a RUN executes: the exec-form `-c` argument, or the shell form plus heredocs that feed a shell. */
function runScript({ args: raw, heredocs }: Instruction): string {
  const args = raw.replace(/^(?:--\S+\s+)*/, '');
  if (args.startsWith('[')) {
    const exec = jsonArray(args);
    if (exec !== undefined) {
      const flag = exec.indexOf('-c');
      return shells.has(basename(exec[0] ?? '')) && flag > 0 && flag + 1 < exec.length ? exec[flag + 1]! : exec.join(' ');
    }
  }
  const items = rawWords(args);
  const isMarker = (word: string | undefined): boolean => word !== undefined && /^\d*<<-?[^<]+$/.test(word);
  const feedsShell = isMarker(items[0]) || (shells.has(basename(items[0] ?? '')) && items.some(isMarker));
  return feedsShell ? [args, ...heredocs].join('\n') : args;
}

function jsonArray(text: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Split a shell script into pipelines of commands, each a list of unquoted words; comments are dropped. */
function pipelines(script: string): string[][][] {
  const result: string[][][] = [];
  let pipeline: string[][] = [];
  let current: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  const endWord = (): void => {
    if (started) current.push(word);
    word = '';
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (current.length > 0) pipeline.push(current);
    current = [];
  };
  const endPipeline = (): void => {
    endCommand();
    if (pipeline.length > 0) result.push(pipeline);
    pipeline = [];
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    const previous = script[index - 1];
    const next = script[index + 1];
    const controlOperator = (char === '&' || char === '|') && previous !== '>' && previous !== '<' && next !== '>';
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && next !== undefined) word += script[++index];
      else word += char;
    } else if (char === '\\') {
      if (next === '\n') index++;
      else if (next !== undefined) {
        word += script[++index];
        started = true;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '#' && !started) {
      while (index + 1 < script.length && script[index + 1] !== '\n') index++;
    } else if (char === '\n' || char === ';') {
      endPipeline();
    } else if (controlOperator && char === '|' && next !== '|') {
      if (next === '&') index++;
      endCommand();
    } else if (controlOperator) {
      if (next === char) index++;
      endPipeline();
    } else if (/\s/.test(char) || char === '(' || char === ')') {
      endWord();
    } else {
      word += char;
      started = true;
    }
  }
  endPipeline();
  return result;
}

/** Resolve the executed program, skipping variable assignments and wrappers such as sudo or env with their options. */
function command(items: readonly string[]): { readonly name: string | undefined; readonly args: readonly string[]; readonly sudo: boolean } {
  let sudo = false;
  let index = 0;
  while (index < items.length) {
    const word = items[index]!;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      index++;
      continue;
    }
    const name = basename(word);
    if (!prefixes.has(name)) return { name, args: items.slice(index + 1), sudo };
    if (name === 'sudo') sudo = true;
    index++;
    while (index < items.length && items[index]!.startsWith('-') && items[index] !== '-') {
      index += prefixOptionsWithValues.has(items[index]!) ? 2 : 1;
    }
  }
  return { name: undefined, args: [], sudo };
}

function pipesDownloadToShell(pipeline: readonly string[][]): boolean {
  const names = pipeline.map(items => command(items).name);
  const download = names.findIndex(name => name === 'curl' || name === 'wget');
  return download >= 0 && names.slice(download + 1).some(name => name !== undefined && shells.has(name));
}

function upgradesAllPackages(items: readonly string[]): boolean {
  const { name, args } = command(items);
  if (name !== 'apt-get' && name !== 'apt') return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (aptOptionsWithValues.has(arg)) index++;
    else if (!arg.startsWith('-')) return upgrades.has(arg);
  }
  return false;
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}
