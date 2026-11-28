import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gitRoot, gitWorkingTreePaths, readGitCommit } from './git.js';
import { containsPath, readWorkingTree } from './local.js';
import type { GitSelection } from './git.js';
import type { InventoryObserver } from './local.js';

export interface SourceSelection {
  readonly directory: string;
  readonly output: string;
  readonly source: { readonly workingTree: true } | { readonly revision: string };
}

export async function readInspectionSource(request: SourceSelection, selection: GitSelection, inventory?: InventoryObserver) {
  const { excludes, isSource, claims } = selection;
  const root = await realpath('workingTree' in request.source ? request.directory : await gitRoot(request.directory));
  const output = await physicalPath(resolve(request.output));
  if (containsPath(output, root) || output.split(sep).includes('.git')) {
    throw new Error('Choose a dedicated report directory outside Git metadata');
  }
  const snapshot = 'workingTree' in request.source
    ? await readWorkingTree(root, output, excludes, isSource, claims, await gitWorkingTreePaths(root), inventory)
    : await readGitCommit(root, request.source.revision, selection);
  if (inventory && snapshot.subject.kind === 'commit') {
    for (const { path } of snapshot.inventory ?? []) inventory.record(path);
  }
  const excludedOutput = snapshot.subject.kind === 'working-tree' && containsPath(root, output)
    ? relative(root, output).split(sep).join('/') : null;
  return { root, snapshot, excludedOutput, output };
}

async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}
