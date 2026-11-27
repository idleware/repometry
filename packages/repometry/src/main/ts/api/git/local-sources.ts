import { utf8 } from '@repometry/core/internal/model/snapshot.js';
import { validSubjectId } from '@repometry/core/internal/model/report.js';
import { isSourcePathname } from '@repometry/core/internal/ports/source-provider.js';
import { cacheRoot } from '../cache/root.js';
import { GitBlobBatch } from './blob-batch.js';
import { gitText, gitTreeFiles } from './git.js';
import { cachedBlob } from './source-cache.js';

export function readLocalSources(repository: string, cache = cacheRoot()) {
  const git = new GitBlobBatch(repository);
  const known = new Map<string, Promise<string | undefined>>();

  return {
    async read(revision: string, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
      if (!validSubjectId('commit', revision) || !isSourcePathname(path)) return undefined;
      const key = revision + '\0' + path;
      let oid = known.get(key);
      if (oid === undefined) {
        oid = gitTreeFiles(repository, revision, path).then(entries => entries.find(entry => entry.path === path)?.oid).catch(error => {
          known.delete(key);
          if (error instanceof Error && 'code' in error && typeof error.code === 'number') return undefined;
          throw error;
        });
        known.set(key, oid);
      }
      const id = await oid;
      if (!id) return undefined;
      signal?.throwIfAborted();
      const bytes = await cachedBlob(cache, id, () => git.read(id, signal));
      if (!bytes || bytes.includes(0)) return undefined;
      try {
        utf8(bytes);
        return bytes;
      } catch {
        return undefined;
      }
    },
    close: () => git.close(),
  };
}

export async function sourceRemotes(repository: string): Promise<string[]> {
  const origins = await gitText(repository, ['remote', 'get-url', '--all', 'origin']).catch(() => '');
  return origins.split(/\r?\n/).filter(Boolean);
}
