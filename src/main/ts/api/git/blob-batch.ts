import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { validSubjectId } from '../../core/model/report.js';
import { gitExecutable } from './git-executable.js';

const idleTimeout = 10_000;
const maxBlobBytes = 64 * 1024 * 1024;

export class GitBlobBatch {
  private session?: BlobSession;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(private readonly directory: string) {}

  read(oid: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    if (!validSubjectId('commit', oid)) throw new Error('Invalid source blob ID');
    const pending = this.tail.then(() => this.readOne(oid, signal));
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  close(): void {
    clearTimeout(this.timer);
    this.session?.close();
    this.session = undefined;
  }

  private async readOne(oid: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    clearTimeout(this.timer);
    const session = this.session ??= new BlobSession(this.directory);
    const abort = () => this.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await session.read(oid);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.session) this.timer = setTimeout(() => this.close(), idleTimeout).unref();
    }
  }
}

class BlobSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly chunks: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(directory: string) {
    this.child = spawn(gitExecutable(), ['--no-replace-objects', 'cat-file', '--batch'], { cwd: directory });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.child.on('error', error => this.child.stdout.destroy(error));
    this.chunks = this.child.stdout[Symbol.asyncIterator]();
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }

  async read(oid: string): Promise<Buffer | undefined> {
    await new Promise<void>((resolve, reject) => this.child.stdin.write(oid + '\n', error => error ? reject(error) : resolve()));
    const header = await this.header();
    if (header === oid + ' missing') return undefined;
    const parsed = /^([a-f0-9]+) blob ([0-9]+)$/.exec(header);
    const size = Number(parsed?.[2]);
    if (parsed?.[1] !== oid || !Number.isSafeInteger(size)) throw new Error('Invalid Git source blob response');
    if (size > maxBlobBytes) throw new Error('Git source blob exceeds the read limit');
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      if (this.buffer.length === 0) this.buffer = await this.chunk();
      const copied = this.buffer.copy(bytes, offset, 0, size - offset);
      offset += copied;
      this.buffer = this.buffer.subarray(copied);
    }
    if (this.buffer.length === 0) this.buffer = await this.chunk();
    if (this.buffer[0] !== 10) throw new Error('Invalid Git source blob terminator');
    this.buffer = this.buffer.subarray(1);
    return bytes;
  }

  private async header(): Promise<string> {
    let index = this.buffer.indexOf(10);
    while (index < 0) {
      if (this.buffer.length > 256) throw new Error('Invalid Git source blob header');
      this.buffer = Buffer.concat([this.buffer, await this.chunk()]);
      index = this.buffer.indexOf(10);
    }
    const header = this.buffer.toString('ascii', 0, index);
    this.buffer = this.buffer.subarray(index + 1);
    return header;
  }

  private async chunk(): Promise<Buffer> {
    const result = await this.chunks.next();
    if (result.done) throw new Error('Git source reader stopped');
    return result.value;
  }
}
