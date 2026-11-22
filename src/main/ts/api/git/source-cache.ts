import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validSubjectId } from '../../core/model/report.js';

export function sourceCacheRoot(env: NodeJS.ProcessEnv = process.env, system = process.platform, home = homedir()): string {
  if (env.REPOMETRY_CACHE_DIR) return resolve(env.REPOMETRY_CACHE_DIR);
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME, 'repometry');
  if (system === 'darwin') return join(home, 'Library', 'Caches', 'repometry');
  if (system === 'win32' && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, 'repometry', 'cache');
  return join(home, '.cache', 'repometry');
}

export async function clearSourceCache(root = sourceCacheRoot()): Promise<void> {
  await rm(join(root, 'sources'), { recursive: true, force: true });
}

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
