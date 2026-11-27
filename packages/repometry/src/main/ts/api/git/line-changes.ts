import { addedRanges, diffMethod, oid, patchHunks, rawChanges, regularFile, removedRanges, stableDiff } from './changes.js';
import { GitBlobReader, gitText, gitUtf8 } from './git.js';
import type { FileLineChange, LineChanges, LineRange } from '../../core/model/changes.js';

/**
 * The changed lines of every regular file between two commits, on both sides, following renames. A binary file, or one
 * whose line breaks Git and parsers may count differently, changes as a whole.
 */
export async function readLineChanges(repository: string, base: string, head: string): Promise<LineChanges> {
  if (!oid.test(base) || !oid.test(head)) throw new Error('Git diff requires full commit IDs');
  if (base === head) return { files: [] };
  const raw = await gitUtf8(repository, ['diff', ...stableDiff, '--raw', '-z', '--no-abbrev',
    `--find-renames=${diffMethod.renameThresholdPercent}%`, `-l${diffMethod.renameLimit}`, base, head, '--']);
  const blobs = new GitBlobReader(repository);
  const files: FileLineChange[] = [];
  // One file at a time: a large change must not start a Git process per file at once.
  for (const change of rawChanges(raw)) {
    const file = await fileChange(repository, blobs, change);
    if (file) files.push(file);
  }
  return { files };
}

async function fileChange(repository: string, blobs: GitBlobReader, change: ReturnType<typeof rawChanges>[number])
  : Promise<FileLineChange | undefined> {
  const path = regularFile.test(change.mode) ? change.path : null;
  const { previous } = change;
  if (path === null && previous === undefined) return undefined;
  const text = (id: string | undefined) => id === undefined ? Promise.resolve('') : blobs.read([id]).then(([bytes]) => lineText(bytes));
  const [headText, baseText] = await Promise.all([text(path === null ? undefined : change.oid), text(previous?.oid)]);
  const file = { path, previous: previous?.path ?? null };
  if (headText === undefined || baseText === undefined) return { ...file, added: [], removed: [], whole: true, hunks: [] };
  if (path === null || previous === undefined) {
    return { ...file, added: wholeRange(headText), removed: wholeRange(baseText), whole: false, hunks: [] };
  }
  const patch = await gitText(repository, ['diff', ...stableDiff, '--text', '--unified=0', '--inter-hunk-context=0', previous.oid, change.oid, '--']);
  return { ...file, added: addedRanges(patch), removed: removedRanges(patch), whole: false, hunks: patchHunks(patch) };
}

/** Text whose lines Git numbers the same way parsers do, or undefined. */
function lineText(bytes: Buffer | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return /\0|\r(?!\n)|[\u2028\u2029]/.test(text) ? undefined : text;
}

function wholeRange(text: string): readonly LineRange[] {
  const count = text.split('\n').length - Number(text.endsWith('\n'));
  return text === '' ? [] : [{ first: 1, last: count }];
}
