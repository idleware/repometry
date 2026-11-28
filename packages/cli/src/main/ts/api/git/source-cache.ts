import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validSubjectId } from '@repometry/core/internal/model/report.js';

export async function cachedBlob(root: string, oid: string, load: () => Promise<Buffer | undefined>): Promise<Buffer | undefined> {
  if (!validSubjectId('commit', oid)) throw new Error('Invalid source blob ID');
  const folder = join(root, 'sources', oid.slice(0, 2));
  const path = join(folder, oid);
  try {
    if ((await lstat(path)).isFile()) {
      const hit = await readFile(path);
      if (blobMatches(oid, hit)) return hit;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const bytes = await load();
  if (bytes === undefined || !blobMatches(oid, bytes)) return undefined;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

function blobMatches(oid: string, bytes: Buffer): boolean {
  return createHash(oid.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === oid;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
