import { gitText, resolveGitCommit } from './git.js';
import type { CommitMetadata, ReadCommitMetadata } from '../../report/json/projections/commit-summary.js';

export function commitMetadataReader(repository: string): ReadCommitMetadata {
  return async revisions => {
    const result = new Map<string, CommitMetadata>();
    for (let start = 0; start < revisions.length; start += 128) {
      const batch = revisions.slice(start, start + 128);
      const log = await gitText(repository, ['log', '--ignore-missing', '--no-walk=unsorted', '-z', '--no-show-signature',
        '--format=%H%x00%an%x00%ae%x00%B', ...batch, '--']);
      const fields = log.split('\0');
      for (let index = 0; index + 3 < fields.length; index += 4) {
        const [sha, name, email, message] = fields.slice(index, index + 4) as [string, string, string, string];
        result.set(sha, { subject: message.split(/\r?\n/, 1)[0]!, author: { name, email } });
      }
    }
    const requested = new Set(revisions);
    for (const [sha, tags] of await tagsByCommit(repository)) {
      if (requested.has(sha)) result.set(sha, { ...result.get(sha), tags });
    }
    return result;
  };
}

async function tagsByCommit(repository: string): Promise<Map<string, string[]>> {
  const refs = await gitText(repository, ['show-ref', '--tags', '--dereference']).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 1) return '';
    throw error;
  });
  const tags = new Map<string, string>();
  for (const line of refs.split('\n')) {
    const match = /^([a-f0-9]+) refs\/tags\/(.+?)(?:\^\{\})?$/.exec(line);
    if (match) tags.set(match[2]!, match[1]!);
  }
  const result = new Map<string, string[]>();
  for (const tag of [...tags.keys()].sort()) {
    const sha = tags.get(tag)!;
    const names = result.get(sha) ?? [];
    names.push(tag);
    result.set(sha, names);
  }
  return result;
}

export async function resolveGitBranch(repository: string, name: string): Promise<string> {
  await gitText(repository, ['check-ref-format', `refs/heads/${name}`]);
  try {
    return await resolveGitCommit(repository, `refs/heads/${name}`);
  } catch {
    return resolveGitCommit(repository, `refs/remotes/origin/${name}`);
  }
}
