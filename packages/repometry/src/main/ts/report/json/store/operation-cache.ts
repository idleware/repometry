import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OperationCache } from '../../../core/engine/operation-cache.js';
import { replaceFile } from './replace-file.js';

const digestPattern = /^[a-f0-9]{64}$/;

export class LocalOperationCache implements OperationCache {
  constructor(private readonly directory: string) {}

  async read(key: string): Promise<Uint8Array | undefined> {
    const path = join(this.folder(key), key);
    try {
      return (await lstat(path)).isFile() ? await readFile(path) : undefined;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const folder = this.folder(key);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await replaceFile(folder, key, bytes);
  }

  private folder(key: string): string {
    if (!digestPattern.test(key)) throw new Error('Invalid operation cache key');
    return join(this.directory, key.slice(0, 2));
  }
}
