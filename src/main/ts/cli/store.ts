import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitReportReader } from '../api/git/git-reader.js';
import { gitRoot } from '../api/git/git.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import type { Invocation } from './arguments.js';
import type { ReportReader } from '../report/json/validation/report.js';

export type Store = { readonly reader: ReportReader; readonly path?: string };

export async function findRepository(directory: string): Promise<string | undefined> {
  return gitRoot(directory).catch(() => undefined);
}

/** Where relative paths typed on the command line resolve: --repo/-C, like git -C, or else the current directory. */
export function invocationDirectory(input: Invocation): string {
  return resolve(input.text('repo') ?? '.');
}

/** A typed path resolves against `base`; the default store resolves against the repository root. */
export function selectStore(root: string, value?: string, base = root): Store {
  if (value?.startsWith('git:')) {
    const ref = value.slice(4);
    if (!ref) throw new Error('--store git: requires a ref');
    return { reader: new GitReportReader(root, ref) };
  }
  const path = value === undefined ? resolve(root, '.repometry') : resolve(base, value);
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
