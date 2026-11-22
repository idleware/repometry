import { readdir, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { comparePaths, isExcludedDirectory, isSourcePath, workingSnapshot } from '../../core/model/snapshot.js';
import type { SourceFile, SourceSnapshot } from '../../core/model/snapshot.js';
import { isGeneratedSource } from '../../core/profile/exclusions.js';

export function containsPath(parent: string, path: string): boolean {
  const rest = relative(parent, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

export async function readWorkingTree(directory: string, output: string, excludes: (path: string) => boolean): Promise<SourceSnapshot> {
  const root = await realpath(directory);
  const files: SourceFile[] = [];
  const generatedExcluded: string[] = [];
  if (containsPath(output, root)) throw new Error('The output directory must be separate from the source root');

  async function visit(folder: string, prefix: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const absolute = join(folder, entry.name);
      if (excludes(path)) continue;
      if (entry.isDirectory() && !isExcludedDirectory(entry.name) && absolute !== output) {
        await visit(absolute, `${path}/`);
      } else if (entry.isFile() && isSourcePath(path)) {
        const bytes = await readFile(absolute);
        if (isGeneratedSource(bytes)) generatedExcluded.push(path);
        else files.push({ path, bytes });
      }
    }
  }

  await visit(root, '');
  return { ...workingSnapshot(files), generatedExcluded: generatedExcluded.sort(comparePaths) };
}
