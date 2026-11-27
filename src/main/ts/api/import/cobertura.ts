import { posix, win32 } from 'node:path';
import { comparePaths } from '../../core/model/snapshot.js';
import { readCoverageXml } from './coverage-xml.js';
import type { CoverageSource } from './go-cover.js';

interface Branches { readonly covered: number; readonly total: number }
interface Line { readonly number: number; readonly hits: number; readonly branches?: Branches }
interface Method { readonly key: string; first?: Line }
interface Records { readonly lines: Map<number, Line>; readonly methods: Method[] }
interface Class extends Records { readonly filename: string; readonly name: string; readonly xmlLine: number }
type Invalid = (line: number, reason: string) => never;

export function coberturaToLcov(text: string, input: string, source: CoverageSource): string {
  const invalid: Invalid = (line, reason) => { throw new Error('Invalid Cobertura report ' + input + ' at line ' + line + ': ' + reason); };
  const { classes, sources } = parse(text, invalid);
  const resolve = coveragePaths(source, sources);
  const files = new Map<string, Records>();
  for (const item of classes) {
    const path = resolve(item.filename);
    if (/[\r\n\0]/.test(path)) invalid(item.xmlLine, 'filename contains a line break or NUL');
    const file: Records = files.get(path) ?? { lines: new Map(), methods: [] };
    files.set(path, file);
    for (const line of item.lines.values()) mergeLine(file, line);
    for (const method of item.methods) file.methods.push(method);
  }
  return render(files);
}

const [sourcesPath, classesPath] = ['coverage/sources', 'coverage/packages/package/classes'];
const methodsPath = classesPath + '/class/methods';
const maxBranches = 2 ** 24; // Each branch becomes an entry of one Map, which holds at most 2^24.

function parse(input: string, invalid: Invalid) {
  const classes: Class[] = [];
  let branches = 0;
  const sources: string[] = [];
  let current: Class | undefined;
  let method: Method | undefined;
  let sourceText: string[] | undefined;
  readCoverageXml(input, invalid, {
    open(name, attributes, parents, line) {
      const path = parents.join('/');
      if (name === 'source' && path === sourcesPath) sourceText = [];
      if (name === 'class' && path === classesPath) {
        const filename = attributes.get('filename');
        if (!filename?.trim()) return invalid(line, '<class> has no filename');
        current = { filename, name: attributes.get('name') ?? '', lines: new Map(), methods: [], xmlLine: line };
        classes.push(current);
      }
      if (!current) return;
      if (name === 'method' && path === methodsPath) {
        const key = current.name + '.' + (attributes.get('name') ?? '') + (attributes.get('signature') ?? '');
        if (/[\r\n\0]/.test(key)) invalid(line, 'method name contains a line break or NUL');
        method = { key };
        current.methods.push(method);
      }
      if (name !== 'line') return;
      if (path === classesPath + '/class/lines') {
        const entry = readLine(attributes, line, invalid, true);
        branches += entry.branches?.total ?? 0;
        if (branches > maxBranches) invalid(line, 'too many branches');
        mergeLine(current, entry);
      }
      if (method && path === methodsPath + '/method/lines') {
        const entry = readLine(attributes, line, invalid, false);
        if (!method.first || entry.number < method.first.number) method.first = entry;
      }
    },
    close(name, parents) {
      const path = parents.join('/');
      if (name === 'source' && path === sourcesPath && sourceText) {
        const value = sourceText.join('').trim();
        if (value) sources.push(value);
        sourceText = undefined;
      }
      if (name === 'class' && path === classesPath) current = undefined;
      if (name === 'method' && path === methodsPath) method = undefined;
    },
    text(value, parents) {
      if (sourceText && parents.join('/') === sourcesPath + '/source') sourceText.push(value);
    },
  });
  return { classes, sources };
}

function readLine(attributes: ReadonlyMap<string, string>, xmlLine: number, invalid: Invalid, classLine: boolean): Line {
  const rawLine = attributes.get('number') ?? '';
  const rawHits = attributes.get('hits') ?? '';
  const number = Number(rawLine);
  const hits = Number(rawHits);
  if (!/^\d+$/.test(rawLine) || !Number.isSafeInteger(number) || number === 0) invalid(xmlLine, 'line number must be a positive integer');
  if (!/^\d+$/.test(rawHits)) invalid(xmlLine, 'hits must be a non-negative integer');
  if (!Number.isSafeInteger(hits)) invalid(xmlLine, 'hit count exceeds the supported integer range');
  return { number, hits, branches: classLine ? readBranches(attributes.get('condition-coverage'), xmlLine, invalid) : undefined };
}

function readBranches(value: string | undefined, xmlLine: number, invalid: Invalid): Branches | undefined {
  const match = value === undefined ? null : /^\d+(?:\.\d+)?%\s*\((\d+)\/(\d+)\)$/.exec(value);
  if (!match) return undefined;
  const covered = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(covered) || total === 0 || covered > total) {
    invalid(xmlLine, 'invalid condition-coverage ' + JSON.stringify(value));
  }
  return { covered, total };
}

function mergeLine(file: Records, line: Line): void {
  const previous = file.lines.get(line.number);
  const before = previous?.branches;
  const next = line.branches;
  const branches = next && (!before || next.total > before.total || (next.total === before.total && next.covered > before.covered))
    ? next : before;
  file.lines.set(line.number, { number: line.number, hits: Math.max(line.hits, previous?.hits ?? 0), branches });
}

function coveragePaths({ root, snapshot }: CoverageSource, sources: readonly string[]) {
  const platform = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
  const slash = (path: string) => platform === win32 ? path.replaceAll('\\', '/') : path;
  const known = new Set([...snapshot.files.map(file => file.path), ...(snapshot.generatedExcluded ?? []),
    ...(snapshot.inventory?.map(file => file.path) ?? [])]);
  const normalize = (path: string) => slash(platform.isAbsolute(path) ? platform.relative(root, path) || '.' : platform.normalize(path));
  const paths = new Map<string, string>();
  return (filename: string): string => {
    const prior = paths.get(filename);
    if (prior !== undefined) return prior;
    const candidates = platform.isAbsolute(filename) ? [normalize(filename)]
      : [...sources.map(source => normalize(platform.join(source, filename))), normalize(filename)];
    const matches = [...new Set(candidates)].filter(path => known.has(path));
    if (matches.length > 1) throw new Error('Ambiguous Cobertura source ' + JSON.stringify(filename) + ': ' + matches.sort(comparePaths).join(', '));
    const selected = matches[0] ?? candidates.at(-1)!; // An unknown relative filename stays relative to the root.
    paths.set(filename, selected);
    return selected;
  };
}

function render(files: ReadonlyMap<string, Records>): string {
  const output: string[] = [];
  for (const [path, { lines, methods }] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    output.push('SF:' + path);
    for (const { key, first } of methods) if (first) output.push('FN:' + first.number + ',' + key, 'FNDA:' + first.hits + ',' + key);
    for (const { number, hits, branches } of [...lines.values()].sort((a, b) => a.number - b.number)) {
      output.push('DA:' + number + ',' + hits);
      if (!branches) continue;
      const prefix = 'BRDA:' + number + ',0,';
      for (let index = 0; index < branches.total; index++) output.push(prefix + index + ',' + Number(index < branches.covered));
    }
    output.push('end_of_record');
  }
  return output.join('\n');
}
