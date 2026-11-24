import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { isRecord } from './plugin-data.js';
import type { DataContract } from '../engine/plugin.js';

import type { SourceFile, SourceSnapshot } from './source.js';
export type { Subject, SourceFile, SourceSnapshot } from './source.js';

export const sourceFile: DataContract<SourceFile> = {
  id: 'repometry.source-file/v1',
  accepts: (value): value is SourceFile => isRecord(value) && typeof value.path === 'string' && value.bytes instanceof Uint8Array,
};

export const sourceFiles: DataContract<readonly SourceFile[]> = {
  id: 'repometry.source-files/v1',
  accepts: (value): value is readonly SourceFile[] => Array.isArray(value) && value.every(sourceFile.accepts),
};

export const sourceDirectoriesExcluded = ['.git', '.repometry', 'node_modules', 'target'] as const;
export const sourceExtensions = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'] as const;
const excluded = new Set<string>(sourceDirectoriesExcluded);
const extensions = new Set<string>(sourceExtensions);

export function isSourcePath(path: string): boolean {
  return extensions.has(extname(path)) && !path.split('/').slice(0, -1).some(isExcludedDirectory);
}

export function isExcludedDirectory(name: string): boolean {
  return excluded.has(name);
}

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function physicalLines(text: string): number {
  if (text === '') return 0;
  return text.split(/\r\n|[\n\r\u2028\u2029]/).length - Number(/[\n\r\u2028\u2029]$/.test(text));
}

export function sourceLineCounts(files: readonly SourceFile[]): ReadonlyMap<string, number> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return new Map(files.map(file => [file.path, physicalLines(decoder.decode(file.bytes))]));
}

export function textLineCount(bytes: Uint8Array): number | null {
  if (bytes.includes(0)) return null;
  try {
    return physicalLines(utf8(bytes));
  } catch {
    return null;
  }
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function workingSnapshot(files: SourceFile[]): SourceSnapshot {
  files.sort((left, right) => comparePaths(left.path, right.path));
  const id = digest(JSON.stringify(files.map(file => [file.path, digest(file.bytes)])));
  return { subject: { kind: 'working-tree', id }, files };
}
