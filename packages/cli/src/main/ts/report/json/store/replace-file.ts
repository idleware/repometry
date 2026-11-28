import { randomUUID } from 'node:crypto';
import { link, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode } from './directory.js';

export async function replaceFile(directory: string, name: string, contents: string | Uint8Array,
  onlyIfMissing = false): Promise<void> {
  const destination = join(directory, name);
  if (onlyIfMissing && await exists(destination)) return;
  const temporary = join(directory, `.repometry-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (onlyIfMissing) await link(temporary, destination).catch(error => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
    else await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}
