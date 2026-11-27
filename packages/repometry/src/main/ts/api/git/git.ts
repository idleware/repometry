import { realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { comparePaths, isExcludedDirectory, utf8 } from '@repometry/core/internal/model/snapshot.js';
import type { SourceSnapshot } from '@repometry/core/internal/model/snapshot.js';
import { isClaimedText, maxClaimedFileBytes } from '@repometry/core/internal/model/source.js';
import { isGeneratedSource } from '@repometry/core/internal/profile/exclusions.js';
import { gitExecutable } from './git-executable.js';
import { GitBlobHistory, gitBlobBatchBytes } from './blob-history.js';
import type { BlobRequest } from './blob-history.js';

const git = promisify(execFile);
const maxBuffer = gitBlobBatchBytes;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const baseEnv = { ...process.env, GIT_NO_LAZY_FETCH: '1' };

function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...baseEnv, PATH: process.env.PATH };
}

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
  const { stdout } = await git(gitExecutable(), ['--no-replace-objects', ...args], { cwd: directory, env: gitEnvironment(), maxBuffer, timeout });
  return stdout;
}

export async function gitUtf8(directory: string, args: readonly string[], timeout?: number): Promise<string> {
  const result = await git(gitExecutable(), ['--no-replace-objects', ...args], { cwd: directory, env: gitEnvironment(), encoding: 'buffer', maxBuffer, timeout });
  return utf8(result.stdout);
}

export async function gitWorkingTreePaths(directory: string): Promise<readonly string[] | undefined> {
  try {
    const { stdout } = await git(gitExecutable(), ['--no-replace-objects', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { cwd: directory, env: { ...gitEnvironment(), LC_ALL: 'C' }, encoding: 'buffer', maxBuffer });
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
  const tree = await git(gitExecutable(), args, { cwd: directory, env: gitEnvironment(), encoding: 'buffer', maxBuffer });
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
    const child = spawn(gitExecutable(), ['--no-replace-objects', 'cat-file', '--batch'], { cwd: this.directory, env: gitEnvironment() });
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

export interface GitSelection {
  readonly excludes: (path: string) => boolean;
  readonly isSource: (path: string) => boolean;
  readonly claims?: (path: string) => boolean;
  readonly history?: GitBlobHistory;
}

export async function readGitCommit(directory: string, revision: string,
  { excludes, isSource, claims, history }: GitSelection): Promise<SourceSnapshot> {
  const id = await resolveGitCommit(directory, revision);
  const tracked = (await gitTreeFiles(directory, id, undefined, true)).filter(({ path }) =>
    !path.split('/').slice(0, -1).some(isExcludedDirectory) && !excludes(path));
  const entries = tracked.filter(({ path }) => isSource(path));
  const claimed = tracked.filter(({ path }) => !isSource(path) && claims?.(path));
  const oversized = new Set(claimed.filter(({ size }) => size !== undefined && size > maxClaimedFileBytes).map(({ path }) => path));
  const requested = claimed.filter(({ path }) => !oversized.has(path));
  const blobs = await (history ?? new GitBlobHistory()).read(
    blobRequests(tracked.filter(({ path }) => !oversized.has(path)), entries, requested), ids => readBlobs(directory, ids));
  const generated = new Set<string>();
  const files = entries.flatMap(({ path, oid }) => {
    const bytes = blobs.get(oid)?.bytes;
    if (!bytes) throw new Error(`Git blob unavailable: ${oid}`);
    if (!isGeneratedSource(bytes)) return [{ path, bytes: snapshotBytes(bytes, history) }];
    generated.add(path);
    return [];
  });
  for (const { path, oid } of requested) {
    const bytes = blobs.get(oid)?.bytes;
    if (bytes && isClaimedText(bytes)) files.push({ path, bytes: snapshotBytes(bytes, history) });
  }
  files.sort((left, right) => comparePaths(left.path, right.path));
  const inventory = tracked.filter(({ path }) => !generated.has(path)).map(({ path, oid, size }) => ({ path, lines: blobs.get(oid)?.lines ?? null, ...(size === undefined ? {} : { bytes: size }) }));
  const blobIds = new Map(tracked.map(({ path, oid }) => [path, oid]));
  return { subject: { kind: 'commit', id }, files, blobIds, inventory, generatedExcluded: [...generated].sort(comparePaths),
    ...(oversized.size ? { oversizedClaims: [...oversized].sort(comparePaths) } : {}) };
}

function snapshotBytes(bytes: Buffer, history: GitBlobHistory | undefined): Buffer {
  // Inspectors receive mutable byte arrays. Keep retained Git data independent of those inputs.
  return history === undefined ? bytes : Buffer.from(bytes);
}

function blobRequests(tracked: readonly GitFile[], sources: readonly GitFile[], claimed: readonly GitFile[]): BlobRequest[] {
  const required = new Set(sources.map(({ oid }) => oid));
  const contents = new Set([...required, ...claimed.map(({ oid }) => oid)]);
  const byId = new Map(tracked.map(({ oid, size }) => [oid, size]));
  const requests: BlobRequest[] = [];
  for (const [id, size] of byId) {
    if (size !== undefined && size + 128 <= maxBuffer) {
      requests.push({ id, estimatedBytes: size + 128, contents: contents.has(id) });
    } else if (required.has(id)) {
      requests.push({ id, estimatedBytes: maxBuffer, contents: true });
    }
  }
  return requests;
}

async function readBlobs(directory: string, ids: readonly string[]): Promise<ReadonlyMap<string, Buffer>> {
  const command = git(gitExecutable(), ['--no-replace-objects', 'cat-file', '--batch'], { cwd: directory, env: gitEnvironment(), encoding: 'buffer', maxBuffer });
  command.child.stdin?.on('error', () => {});
  command.child.stdin?.end(`${ids.join('\n')}\n`);
  const { stdout } = await command.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number'
      && 'stderr' in error && Buffer.isBuffer(error.stderr)) {
      throw new Error(`git cat-file failed: ${error.stderr.toString('utf8').trim()}`, { cause: error });
    }
    throw error;
  });
  const blobs = new Map<string, Buffer>();

  let cursor = 0;
  for (const oid of ids) {
    const end = stdout.indexOf(10, cursor);
    if (end < 0) throw new Error(`Missing Git blob header: ${oid}`);
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(stdout.toString('ascii', cursor, end));
    const size = Number(match?.[2]);
    const from = end + 1;
    const to = from + size;
    if (match?.[1] !== oid || !Number.isSafeInteger(size) || stdout[to] !== 10) throw new Error(`Invalid Git blob: ${oid}`);
    blobs.set(oid, stdout.subarray(from, to));
    cursor = to + 1;
  }
  return blobs;
}
