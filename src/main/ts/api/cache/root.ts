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

export const goParserCacheDirectory = 'go-parsers-v1';

export async function clearCaches(root: string, sourcesOnly: boolean): Promise<readonly string[]> {
  const directories = sourcesOnly ? ['sources'] : ['sources', goParserCacheDirectory];
  await Promise.all(directories.map(directory => rm(join(root, directory), { recursive: true, force: true })));
  return directories;
}
