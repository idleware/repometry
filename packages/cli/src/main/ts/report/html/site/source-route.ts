import { validSubjectId } from '@repometry/core/internal/model/report.js';
import { isSourcePathname } from '@repometry/core/internal/ports/source-provider.js';
import type { SourceProvider } from '@repometry/core/internal/ports/source-provider.js';

export interface SourceAccess {
  readonly read: NonNullable<SourceProvider['read']>;
  readonly close?: () => void;
}

export async function sourceResponse(name: string, access: SourceAccess | undefined,
  listed: (revision: string, path: string) => Promise<boolean>): Promise<Uint8Array | undefined> {
  if (!access) return undefined;
  const [prefix, revision, ...segments] = name.split('/');
  if (prefix !== 'sources' || revision === undefined || !validSubjectId('commit', revision)) return undefined;
  let path: string;
  try {
    const decoded = segments.map(decodeURIComponent);
    if (decoded.some(part => part.includes('/'))) return undefined;
    path = decoded.join('/');
  } catch {
    return undefined;
  }
  if (!isSourcePathname(path) || !await listed(revision, path)) return undefined;
  return access.read(revision, path);
}
