import { readFile } from 'node:fs/promises';
import { comparePaths, digest, utf8 } from '../../core/model/snapshot.js';

export type LcovFiles = string | readonly string[];

export async function readLcovFiles(input: LcovFiles) {
  const paths = typeof input === 'string' ? [input] : input;
  if (paths.length === 0) throw new Error('Provide at least one LCOV file');
  const sources = await Promise.all(paths.map(async path => {
    const text = utf8(await readFile(path));
    return { text, digest: digest(text) };
  }));
  sources.sort((a, b) => comparePaths(a.digest, b.digest));
  return { text: sources.map(source => source.text).join('\n'), inputDigests: sources.map(source => source.digest) };
}
