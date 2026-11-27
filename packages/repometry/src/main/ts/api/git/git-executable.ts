import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

let resolved: { readonly path: string | undefined; readonly executable: string } | undefined;

export function gitExecutable(path = process.env.PATH): string {
  if (resolved && resolved.path === path) return resolved.executable;
  const executable = findGit(path);
  resolved = { path, executable };
  return executable;
}

function findGit(path: string | undefined): string {
  // Preserve native lookup for Windows and for PATH entries relative to the child's working directory.
  if (process.platform === 'win32' || path === undefined) return 'git';
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) return 'git';
    const candidate = join(directory, 'git');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching when this entry cannot run Git.
    }
  }
  return 'git';
}
