import { lstat, readFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { comparePaths, sourceLineCounts } from '@repometry/core/internal/model/snapshot.js';
import type { SourceSnapshot } from '@repometry/core/internal/model/source.js';

export interface CoverageSource {
  readonly root: string;
  readonly snapshot: SourceSnapshot;
  readonly readCommittedManifest?: (path: string) => Promise<string>;
}

interface GoSource {
  readonly lines: ReadonlyMap<string, number>;
  path(input: string): string;
}

interface Block {
  readonly first: number;
  readonly last: number;
  readonly statements: number;
  hits: number;
}

export async function goCoverSource(source: CoverageSource): Promise<GoSource> {
  const { root, snapshot } = source;
  const lines = sourceLineCounts(snapshot.files.filter(({ path }) => path.endsWith('.go')));
  const known = new Set([...lines.keys(), ...(snapshot.generatedExcluded ?? []),
    ...(snapshot.inventory?.map(({ path }) => path) ?? [])]);
  const modules = await goModules(source, known);
  const platform = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
  return {
    lines,
    path(input) {
      const path = platform === win32 ? input.replaceAll('\\', '/') : input;
      if (platform.isAbsolute(path)) {
        const relative = platform.relative(root, path) || '.';
        return platform === win32 ? relative.replaceAll('\\', '/') : relative;
      }
      const relative = posix.normalize(path);
      if (path.startsWith('./') || relative.startsWith('../') || win32.isAbsolute(path)) return relative;
      const candidates = new Set(modules.flatMap(({ directory, module }) => relative.startsWith(`${module}/`)
        ? [posix.join(directory, relative.slice(module.length + 1))] : []));
      const matches = [...new Set([relative, ...candidates])].filter(candidate => known.has(candidate));
      if (matches.length > 1) throw new Error(`Ambiguous Go coverprofile source ${JSON.stringify(input)}: ${matches.sort(comparePaths).join(', ')}`);
      // Keep an unresolved import path so the normal coverage pipeline can report the missing source.
      return matches[0] ?? (candidates.size === 1 ? [...candidates][0]! : relative);
    },
  };
}

async function goModules({ root, snapshot, readCommittedManifest }: CoverageSource, known: ReadonlySet<string>) {
  const { subject } = snapshot;
  const manifests = new Set<string>();
  if (subject.kind === 'commit') {
    for (const path of known) if (posix.basename(path) === 'go.mod') manifests.add(path);
  } else {
    manifests.add('go.mod');
    for (const path of known) {
      if (!path.endsWith('.go')) continue;
      for (let directory = posix.dirname(path); directory !== '.'; directory = posix.dirname(directory)) {
        const manifest = posix.join(directory, 'go.mod');
        if (manifests.has(manifest)) break;
        manifests.add(manifest);
      }
    }
  }
  const modules = await Promise.all([...manifests].map(async path => {
    const text = subject.kind === 'commit'
      ? await readCommittedManifest?.(path) ?? '' : await workingManifest(join(root, path));
    return { directory: posix.dirname(path), module: modulePath(text) };
  }));
  return modules.flatMap(({ directory, module }) => module === undefined ? [] : [{ directory, module }]);
}

async function workingManifest(path: string): Promise<string> {
  try {
    return (await lstat(path)).isFile() ? await readFile(path, 'utf8') : '';
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return '';
    throw error;
  }
}

function modulePath(text: string): string | undefined {
  let grouped = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;
    const value = grouped ? line : /^module[ \t]+(.+)$/.exec(line)?.[1];
    if (value === undefined) continue;
    if (value === '(') {
      grouped = true;
      continue;
    }
    const path = value.replace(/^"([^"]*)"$|^`([^`]*)`$/, '$1$2');
    if (/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*$/.test(path) && !path.split('/').some(part => part === '.' || part === '..')) {
      return path;
    }
    return undefined;
  }
}

export function goCoverToLcov(text: string, input: string, source: GoSource): string {
  const [header, ...records] = text.split(/\r?\n/);
  const mode = /^mode: (set|count|atomic)$/.exec(header ?? '')?.[1];
  if (!mode) throw new Error(`Invalid Go coverprofile ${input} at line 1: expected mode: set, count, or atomic`);
  const files = new Map<string, Map<string, Block>>();
  const paths = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    if (record === '' && index === records.length - 1) break;
    const invalid = (reason: string) => new Error(`Invalid Go coverprofile ${input} at line ${index + 2}: ${reason}`);
    const match = /^([^\0]+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(record);
    if (!match) throw invalid('expected file:startLine.startColumn,endLine.endColumn statements hits');
    const [first, startColumn, end, endColumn, statements, count] = match.slice(2).map(Number) as [number, number, number, number, number, number];
    if (![first, startColumn, end, endColumn, statements, count].every(Number.isSafeInteger)
      || first < 1 || startColumn < 1 || endColumn < 1 || end < first || (end === first && endColumn < startColumn)) {
      throw invalid('invalid block coordinates or counts');
    }
    const raw = match[1]!;
    const path = paths.get(raw) ?? source.path(raw);
    paths.set(raw, path);
    const blocks = files.get(path) ?? new Map<string, Block>();
    files.set(path, blocks);
    const key = `${first}.${startColumn},${end}.${endColumn}`;
    const previous = blocks.get(key);
    if (previous && previous.statements !== statements) throw invalid('conflicting statement counts for the same block');
    const hits = mode === 'set' ? Number((previous?.hits ?? 0) > 0 || count > 0) : (previous?.hits ?? 0) + count;
    if (!Number.isSafeInteger(hits)) throw invalid('hit count exceeds the supported integer range');
    // Go's end column is exclusive. A block ending at column 1 never touches that source line.
    const last = end - Number(endColumn === 1);
    blocks.set(key, { first, last: end === first && endColumn === startColumn ? first - 1 : last, statements, hits });
  }

  return renderLcov(files, source.lines);
}

function renderLcov(files: ReadonlyMap<string, ReadonlyMap<string, Block>>, sourceLines: GoSource['lines']): string {
  const output: string[] = [];
  for (const [path, blocks] of [...files].sort(([left], [right]) => comparePaths(left, right))) {
    output.push(`SF:${path}`);
    const lines = new Map<number, number>();
    const length = sourceLines.get(path);
    if (length !== undefined) {
      for (const { first, last, statements, hits } of blocks.values()) {
        if (statements === 0 || first > last) continue;
        // Include a single out-of-range line to let LCOV flag stale coverage without expanding arbitrary coordinates.
        for (let line = Math.min(first, length + 1); line <= Math.min(last, length + 1); line++) {
          // Separate blocks on one line can observe the same execution.
          lines.set(line, Math.max(lines.get(line) ?? 0, hits));
        }
      }
    }
    for (const [line, hits] of [...lines].sort(([left], [right]) => left - right)) output.push(`DA:${line},${hits}`);
    output.push('end_of_record');
  }
  return output.join('\n');
}
