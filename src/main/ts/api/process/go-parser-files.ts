import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../core/model/snapshot.js';

const executableName = process.platform === 'win32' ? 'parser.exe' : 'parser';

export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

export async function privateDirectory(directory: string): Promise<Stats> {
  const info = await lstat(directory);
  if (!info.isDirectory() || !owned(info)) {
    throw new Error(`Expected a directory owned by the current user: ${directory}`);
  }
  return info;
}

function owned(info: Stats): boolean {
  const user = process.getuid?.();
  return user === undefined || (info.uid === user && (info.mode & 0o022) === 0);
}

export async function readCachedParser(directory: string): Promise<string | undefined> {
  const executable = join(directory, executableName);
  try {
    await privateDirectory(directory);
    const info = await lstat(executable);
    if (!info.isFile() || !owned(info)) throw new Error(`Expected a parser owned by the current user: ${executable}`);
    await access(executable, constants.X_OK);
    const [contents, checksum] = await Promise.all([readFile(executable), readFile(join(directory, 'sha256'), 'utf8')]);
    if (digest(contents) === checksum) return executable;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export async function publishParser(cache: string, destination: string, local: string): Promise<string> {
  const staging = await mkdtemp(join(cache, 'build-'));
  try {
    const binary = join(staging, executableName);
    await copyFile(local, binary);
    await chmod(binary, 0o700);
    await writeFile(join(staging, 'sha256'), digest(await readFile(binary)), { mode: 0o600, flag: 'wx' });
    return await installParser(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function installParser(staging: string, destination: string): Promise<string> {
  try {
    await rename(staging, destination);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(String(errorCode(error)))) throw error;
    const published = await readCachedParser(destination);
    if (published) return published;
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  }
  return join(destination, executableName);
}
