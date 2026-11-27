import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function cacheRoot(env: NodeJS.ProcessEnv = process.env, system = process.platform, home = homedir()): string {
  if (env.REPOMETRY_CACHE_DIR) return resolve(env.REPOMETRY_CACHE_DIR);
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME, 'repometry');
  if (system === 'darwin') return join(home, 'Library', 'Caches', 'repometry');
  if (system === 'win32' && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, 'repometry', 'cache');
  return join(home, '.cache', 'repometry');
}

export async function clearCaches(root: string): Promise<readonly string[]> {
  // Also clean the parser cache used by older Repometry versions.
  const directories = ['sources', 'go-parsers-v1'];
  await Promise.all(directories.map(directory => rm(join(root, directory), { recursive: true, force: true })));
  return directories;
}
