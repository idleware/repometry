import { realpath } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { comparePaths, isExcludedDirectory, isSourcePath, textLineCount, utf8 } from '../../core/model/snapshot.js';
import type { SourceSnapshot } from '../../core/model/snapshot.js';
import { isGeneratedSource } from '../../core/profile/exclusions.js';

const git = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };

export async function gitRoot(directory: string): Promise<string> {
  return (await gitText(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
}

export async function physicalGitRoot(directory: string): Promise<string> {
  return realpath(await gitRoot(directory));
}

export async function gitText(directory: string, args: readonly string[], timeout?: number): Promise<string> {
  const { stdout } = await git('git', ['--no-replace-objects', ...args], { cwd: directory, env, maxBuffer, timeout });
  return stdout;
}

export async function gitUtf8(directory: string, args: readonly string[], timeout?: number): Promise<string> {
  const result = await git('git', ['--no-replace-objects', ...args], { cwd: directory, env, encoding: 'buffer', maxBuffer, timeout });
  return utf8(result.stdout);
}

export async function resolveGitCommit(directory: string, revision: string): Promise<string> {
  const id = (await gitText(directory, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
  if (!oidPattern.test(id)) throw new Error('Git returned an invalid commit ID');
  return id;
}

interface GitFile { readonly path: string; readonly oid: string; readonly size?: number }

export async function gitTreeFiles(directory: string, commit: string, prefix?: string, includeSize = false): Promise<readonly GitFile[]> {
  if (!oidPattern.test(commit)) throw new Error('A full commit object ID is required');
  const args = ['--no-replace-objects', '--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree'];
  if (includeSize) args.push('--long');
  args.push(commit);
  if (prefix !== undefined) args.push('--', prefix);
  const tree = await git('git', args, { cwd: directory, env, encoding: 'buffer', maxBuffer });
  const entries: GitFile[] = [];
  for (const entry of utf8(tree.stdout).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const header = entry.slice(0, tab);
    const match = /^100(?:644|755) blob ([a-f0-9]+)(?: +([0-9]+|-))?$/.exec(header);
    const oid = match?.[1];
    const path = entry.slice(tab + 1);
    const size = Number(match?.[2]);
    if (oid && oidPattern.test(oid)) entries.push({ path, oid, ...(Number.isSafeInteger(size) ? { size } : {}) });
  }
  return entries;
}

export async function gitBlobText(directory: string, oid: string): Promise<string> {
  if (!oidPattern.test(oid)) throw new Error('A full blob object ID is required');
  const result = await git('git', ['--no-replace-objects', 'cat-file', 'blob', oid], { cwd: directory, env, encoding: 'buffer', maxBuffer });
  return utf8(result.stdout);
}

export async function readGitCommit(directory: string, revision: string, excludes: (path: string) => boolean): Promise<SourceSnapshot> {
  const id = await resolveGitCommit(directory, revision);
  const tracked = (await gitTreeFiles(directory, id, undefined, true)).filter(({ path }) =>
    !path.split('/').slice(0, -1).some(isExcludedDirectory) && !excludes(path));
  const entries = tracked.filter(entry => isSourcePath(entry.path));
  const blobs = readBlobs(directory, [...new Set(entries.map(entry => entry.oid))]);
  const generated = new Set<string>();
  const files = entries.flatMap(({ path, oid }) => {
    const bytes = blobs.get(oid);
    if (!bytes) throw new Error(`Git blob unavailable: ${oid}`);
    if (!isGeneratedSource(bytes)) return [{ path, bytes }];
    generated.add(path);
    return [];
  });
  files.sort((left, right) => comparePaths(left.path, right.path));
  const counts = inventoryLineCounts(directory, tracked, blobs);
  const inventory = tracked.filter(({ path }) => !generated.has(path)).map(({ path, oid }) => ({ path, lines: counts.get(oid) ?? null }));
  return { subject: { kind: 'commit', id }, files, inventory, generatedExcluded: [...generated].sort(comparePaths) };
}

function inventoryLineCounts(directory: string, entries: readonly GitFile[], sources: ReadonlyMap<string, Buffer>): ReadonlyMap<string, number | null> {
  const lines = new Map([...sources].map(([oid, value]) => [oid, textLineCount(value)]));
  const entriesById = new Map(entries.map(entry => [entry.oid, entry]));
  let batch: string[] = [];
  let bytes = 0;
  for (const [oid, { size }] of entriesById) {
    if (lines.has(oid) || size === undefined || size + 128 > maxBuffer) continue;
    const estimate = size + 128;
    if (bytes + estimate > maxBuffer) flush();
    batch.push(oid);
    bytes += estimate;
  }
  flush();
  return lines;

  function flush(): void {
    for (const [oid, value] of readBlobs(directory, batch)) lines.set(oid, textLineCount(value));
    batch = [];
    bytes = 0;
  }
}

function readBlobs(directory: string, ids: readonly string[]): ReadonlyMap<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (ids.length === 0) return blobs;
  const result = spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], { cwd: directory, env, input: `${ids.join('\n')}\n`, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr.toString('utf8').trim()}`);

  let cursor = 0;
  for (const oid of ids) {
    const end = result.stdout.indexOf(10, cursor);
    if (end < 0) throw new Error(`Missing Git blob header: ${oid}`);
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(result.stdout.toString('ascii', cursor, end));
    const size = Number(match?.[2]);
    const from = end + 1;
    const to = from + size;
    if (match?.[1] !== oid || !Number.isSafeInteger(size) || result.stdout[to] !== 10) throw new Error(`Invalid Git blob: ${oid}`);
    blobs.set(oid, result.stdout.subarray(from, to));
    cursor = to + 1;
  }
  return blobs;
}
