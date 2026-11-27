import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { comparePaths, isExcludedDirectory, workingSnapshot } from '@repometry/core/internal/model/snapshot.js';
import type { SourceFile, SourceSnapshot } from '@repometry/core/internal/model/snapshot.js';
import { isClaimedText, maxClaimedFileBytes } from '@repometry/core/internal/model/source.js';
import { isGeneratedSource } from '@repometry/core/internal/profile/exclusions.js';

export function containsPath(parent: string, path: string): boolean {
  const rest = relative(parent, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

export async function readWorkingTree(directory: string, output: string, excludes: (path: string) => boolean,
  isSource: (path: string) => boolean, claims?: (path: string) => boolean, gitPaths?: readonly string[]): Promise<SourceSnapshot> {
  const root = await realpath(directory);
  const files: SourceFile[] = [];
  const generatedExcluded: string[] = [];
  const oversizedClaims: string[] = [];
  if (containsPath(output, root)) throw new Error('The output directory must be separate from the source root');

  async function visit(folder: string, prefix: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const absolute = join(folder, entry.name);
      if (excludes(path)) continue;
      if (entry.isDirectory() && !isExcludedDirectory(entry.name) && absolute !== output) {
        await visit(absolute, `${path}/`);
      } else if (entry.isFile()) await read(path, absolute);
    }
  }

  async function read(path: string, absolute: string, size?: number): Promise<void> {
    if (isSource(path)) {
      const bytes = await readFile(absolute);
      if (isGeneratedSource(bytes)) generatedExcluded.push(path);
      else files.push({ path, bytes });
      return;
    }
    if (!claims?.(path)) return;
    if ((size ?? (await lstat(absolute)).size) > maxClaimedFileBytes) {
      oversizedClaims.push(path);
      return;
    }
    const bytes = await readFile(absolute);
    if (bytes.length > maxClaimedFileBytes) oversizedClaims.push(path);
    else if (isClaimedText(bytes)) files.push({ path, bytes });
  }

  if (gitPaths === undefined) {
    await visit(root, '');
  } else {
    const directories = new Map<string, boolean>([['.', true]]);

    async function regularDirectory(path: string): Promise<boolean> {
      const cached = directories.get(path);
      if (cached !== undefined) return cached;
      const allowed = !isExcludedDirectory(posix.basename(path)) && await regularDirectory(posix.dirname(path))
        && (await statIfPresent(join(root, path)))?.isDirectory() === true;
      directories.set(path, allowed);
      return allowed;
    }

    for (const path of gitPaths) {
      const absolute = join(root, path);
      if (excludes(path) || !containsPath(root, absolute) || containsPath(output, absolute)) continue;
      if (!(isSource(path) || claims?.(path)) || !await regularDirectory(posix.dirname(path))) continue;
      const stat = await statIfPresent(absolute);
      if (stat?.isFile()) await read(path, absolute, stat.size);
    }
  }
  return { ...workingSnapshot(files), generatedExcluded: generatedExcluded.sort(comparePaths),
    ...(oversizedClaims.length ? { oversizedClaims: oversizedClaims.sort(comparePaths) } : {}) };
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}
