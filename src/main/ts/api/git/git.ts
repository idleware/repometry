import { realpath } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { comparePaths, isExcludedDirectory, textLineCount, utf8 } from '../../core/model/snapshot.js';
import type { SourceSnapshot } from '../../core/model/snapshot.js';
import { isClaimedText, maxClaimedFileBytes } from '../../core/model/source.js';
import { isGeneratedSource } from '../../core/profile/exclusions.js';

const git = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };

export async function gitRoot(directory: string): Promise<string> {
  try {
    return (await gitText(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `${directory} is not a Git repository`;
    throw new Error(process.env.REPOMETRY_DEBUG === '1' ? `${reason}\n${detail}` : reason, { cause: error });
  }
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

export async function gitWorkingTreePaths(directory: string): Promise<readonly string[] | undefined> {
  try {
    const { stdout } = await git('git', ['--no-replace-objects', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: directory, env: { ...env, LC_ALL: 'C' }, encoding: 'buffer', maxBuffer });
    return [...new Set(utf8(stdout).split('\0').filter(Boolean))];
  } catch (error) {
    if (error instanceof Error && ('code' in error && error.code === 'ENOENT'
      || 'stderr' in error && /fatal: not a git repository\b/.test(String(error.stderr)))) return undefined;
    throw error;
  }
}

export async function resolveGitCommit(directory: string, revision: string): Promise<string> {
  let output: string;
  try {
    output = await gitText(directory, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = /not a git repository/i.test(detail) ? `${directory} is not a Git repository` : `${revision} is not a commit in ${directory}`;
    throw new Error(process.env.REPOMETRY_DEBUG === '1' ? `${reason}\n${detail}` : reason, { cause: error });
  }
  const id = output.trim();
  if (!oidPattern.test(id)) throw new Error('Git returned an invalid commit ID');
  return id;
}

/** Commits on the first-parent line of `head` after `base`, oldest first. */
export async function firstParentRange(directory: string, base: string, head: string)
  : Promise<{ readonly base: string; readonly head: string; readonly commits: readonly string[] }> {
  const [from, to] = await Promise.all([resolveGitCommit(directory, base), resolveGitCommit(directory, head)]);
  const commits = (await gitText(directory, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`])).split('\n').filter(Boolean);
  if (!commits.every(id => oidPattern.test(id))) throw new Error('Git returned an invalid commit ID');
  return { base: from, head: to, commits };
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

interface Pending {
  readonly name: string;
  /** Blob content, or the object ID for a name such as `<revision>^{tree}`. */
  readonly want: 'blob' | 'id';
  readonly resolve: (value: Buffer | string | undefined) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Reads blobs named like `<tree>:<path>` through one long-lived `git cat-file --batch`: requests stream in and answers
 * come back in order. A name Git cannot find reads as undefined. The process keeps Node alive only while it owes answers.
 */
export class GitBlobReader {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending: Pending[] = [];
  private chunks: Buffer[] = [];

  constructor(private readonly directory: string) {}

  read(names: readonly string[]): Promise<(Buffer | undefined)[]> {
    return Promise.all(names.map(name => this.request(name, 'blob') as Promise<Buffer | undefined>));
  }

  /** The ID of the object a name resolves to, such as the tree of `<revision>^{tree}`. */
  id(name: string): Promise<string | undefined> {
    return this.request(name, 'id') as Promise<string | undefined>;
  }

  private request(name: string, want: Pending['want']): Promise<Buffer | string | undefined> {
    return new Promise((resolve, reject) => {
      if (/[\r\n]/.test(name)) throw new Error('Invalid Git object name');
      const child = this.child ?? this.start();
      if (this.pending.length === 0) setHeld(child, true);
      this.pending.push({ name, want, resolve, reject });
      child.stdin.write(`${name}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn('git', ['--no-replace-objects', 'cat-file', '--batch'], { cwd: this.directory, env });
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const stop = (error: Error) => this.stop(child, error);
    child.on('error', stop);
    child.stdin.on('error', stop);
    child.on('close', () => stop(new Error(`git cat-file stopped: ${Buffer.concat(errors).toString('utf8').trim()}`)));
    setHeld(child, false);
    this.child = child;
    return child;
  }

  private receive(chunk: Buffer): void {
    this.chunks.push(chunk);
    let buffer = this.chunks.length === 1 ? chunk : Buffer.concat(this.chunks);
    for (let request = this.pending[0]; request; request = this.pending[0]) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      const header = buffer.toString('utf8', 0, end);
      if (header === `${request.name} missing`) {
        buffer = buffer.subarray(end + 1);
        this.answer(undefined);
        continue;
      }
      const [, id, type, length] = /^([a-f0-9]+) ([a-z]+) (\d+)$/.exec(header) ?? [];
      const size = Number(length);
      if (!Number.isSafeInteger(size) || (request.want === 'blob' && type !== 'blob')) {
        this.stop(this.child!, new Error(`Unexpected Git object: ${request.name}`));
        return;
      }
      if (buffer.length < end + size + 2) break;
      const blob = Buffer.from(buffer.subarray(end + 1, end + 1 + size));
      buffer = buffer.subarray(end + size + 2);
      this.answer(request.want === 'blob' ? blob : id);
    }
    this.chunks = buffer.length ? [buffer] : [];
  }

  private answer(value: Buffer | string | undefined): void {
    const request = this.pending.shift()!;
    if (this.pending.length === 0 && this.child) setHeld(this.child, false);
    request.resolve(value);
  }

  private stop(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.chunks = [];
    for (const request of this.pending.splice(0)) request.reject(error);
    child.kill();
  }
}

/** A reader with nothing to answer must not keep the process running. */
function setHeld(child: ChildProcessWithoutNullStreams, held: boolean): void {
  for (const handle of [child, child.stdout, child.stdin, child.stderr] as unknown as { ref(): void; unref(): void }[]) {
    if (held) handle.ref();
    else handle.unref();
  }
}

export async function readGitCommit(directory: string, revision: string, excludes: (path: string) => boolean,
  isSource: (path: string) => boolean, claims?: (path: string) => boolean): Promise<SourceSnapshot> {
  const id = await resolveGitCommit(directory, revision);
  const tracked = (await gitTreeFiles(directory, id, undefined, true)).filter(({ path }) =>
    !path.split('/').slice(0, -1).some(isExcludedDirectory) && !excludes(path));
  const entries = tracked.filter(entry => isSource(entry.path));
  const blobs = readBlobs(directory, [...new Set(entries.map(entry => entry.oid))]);
  const generated = new Set<string>();
  const files = entries.flatMap(({ path, oid }) => {
    const bytes = blobs.get(oid);
    if (!bytes) throw new Error(`Git blob unavailable: ${oid}`);
    if (!isGeneratedSource(bytes)) return [{ path, bytes }];
    generated.add(path);
    return [];
  });
  const claimed = tracked.filter(({ path }) => !isSource(path) && claims?.(path));
  const oversized = new Set(claimed.filter(({ size }) => size !== undefined && size > maxClaimedFileBytes).map(({ path }) => path));
  const requested = new Set(claimed.filter(({ path }) => !oversized.has(path)).map(({ oid }) => oid));
  const claimedBlobs = new Map<string, Buffer>();
  const counts = inventoryLineCounts(directory, tracked.filter(({ path }) => !oversized.has(path)), blobs,
    (oid, bytes) => { if (requested.has(oid) && isClaimedText(bytes)) claimedBlobs.set(oid, bytes); });
  for (const { path, oid } of claimed) {
    const bytes = claimedBlobs.get(oid);
    if (bytes && !oversized.has(path)) files.push({ path, bytes });
  }
  files.sort((left, right) => comparePaths(left.path, right.path));
  const inventory = tracked.filter(({ path }) => !generated.has(path)).map(({ path, oid, size }) => ({ path, lines: counts.get(oid) ?? null, ...(size === undefined ? {} : { bytes: size }) }));
  const blobIds = new Map(tracked.map(({ path, oid }) => [path, oid]));
  return { subject: { kind: 'commit', id }, files, blobIds, inventory, generatedExcluded: [...generated].sort(comparePaths),
    ...(oversized.size ? { oversizedClaims: [...oversized].sort(comparePaths) } : {}) };
}

function inventoryLineCounts(directory: string, entries: readonly GitFile[], sources: ReadonlyMap<string, Buffer>,
  capture: (oid: string, bytes: Buffer) => void): ReadonlyMap<string, number | null> {
  const lines = new Map([...sources].map(([oid, value]) => [oid, textLineCount(value)]));
  for (const [oid, bytes] of sources) capture(oid, bytes);
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
    for (const [oid, value] of readBlobs(directory, batch)) {
      lines.set(oid, textLineCount(value));
      capture(oid, value);
    }
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
