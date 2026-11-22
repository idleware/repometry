import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitReportReader } from '../api/git/git-reader.js';
import { gitRoot } from '../api/git/git.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import type { ReportReader } from '../report/json/validation/report.js';

export type Store = { readonly reader: ReportReader; readonly path?: string };

export async function findRepository(directory: string): Promise<string | undefined> {
  return gitRoot(directory).catch(() => undefined);
}

export function selectStore(root: string, value?: string): Store {
  if (value?.startsWith('git:')) {
    const ref = value.slice(4);
    if (!ref) throw new Error('--store git: requires a ref');
    return { reader: new GitReportReader(root, ref) };
  }
  const path = resolve(root, value ?? '.repometry');
  return { path, reader: new LocalReportStore(path) };
}

export function writableStore(store: Store): string {
  if (store.path === undefined) throw new Error('Use a local store when writing inspections or reviews');
  return store.path;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}
