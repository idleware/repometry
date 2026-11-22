import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitRoot, gitText, resolveGitCommit } from './git.js';
import { containsPath } from './local.js';
import { checkMetaManifest, metaManifest } from '../../report/json/validation/metabranch.js';

export async function openMetabranchWorktree(repository: string, worktree: string, branch: string, sourceCommit: string): Promise<string> {
  await resolveGitCommit(repository, sourceCommit);
  const source = await realpath(await gitRoot(repository));
  const target = await realpath(worktree);
  if (containsPath(source, target) || containsPath(target, source) || await realpath(await gitRoot(target)) !== target) {
    throw new Error('Select the root of a separate worktree outside the source checkout');
  }
  const commonDir = async (path: string) => realpath((await gitText(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).replace(/\r?\n$/, ''));
  if (await commonDir(source) !== await commonDir(target)) throw new Error('Metabranch worktree must belong to the source repository');
  const expectedRef = `refs/heads/${branch}`;
  await gitText(target, ['check-ref-format', expectedRef]);
  if ((await gitText(target, ['symbolic-ref', '--quiet', 'HEAD'])).trim() !== expectedRef) {
    throw new Error(`Metabranch worktree must be on ${expectedRef}`);
  }

  const marker = join(target, 'manifest.json');
  const entries = await readdir(target);
  if (entries.includes('manifest.json')) {
    if (!(await lstat(marker)).isFile()) throw new Error('The metabranch manifest must be a regular file');
    checkMetaManifest(await readFile(marker, 'utf8'));
  } else {
    if (entries.some(name => name !== '.git')) throw new Error('Start from an empty metabranch worktree or an existing Repometry manifest');
    await writeFile(marker, `${JSON.stringify(metaManifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }

  return target;
}
