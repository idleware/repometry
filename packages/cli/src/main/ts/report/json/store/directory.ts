import { lstat, mkdir } from 'node:fs/promises';

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await checkDirectory(path);
}

export async function checkDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a directory: ${path}`);
}
