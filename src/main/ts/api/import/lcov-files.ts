import { readFile } from 'node:fs/promises';
import { comparePaths, digest, utf8 } from '../../core/model/snapshot.js';
import { goCoverSource, goCoverToLcov } from './go-cover.js';
import type { CoverageSource } from './go-cover.js';

export type LcovFiles = string | readonly string[];

export interface CoverageInputs {
  readonly lcov?: LcovFiles;
  readonly goCover?: LcovFiles;
}

export async function readCoverageFiles({ lcov, goCover }: CoverageInputs, source: CoverageSource) {
  const lcovPaths = paths(lcov);
  const goPaths = paths(goCover);
  if (lcov !== undefined && lcovPaths.length === 0) throw new Error('Provide at least one LCOV file');
  if (goCover !== undefined && goPaths.length === 0) throw new Error('Provide at least one Go coverprofile');
  if (lcovPaths.length === 0 && goPaths.length === 0) throw new Error('Provide at least one coverage input');
  const [lcovSources, goSources] = await Promise.all([
    Promise.all(lcovPaths.map(readInput)),
    readGoCoverFiles(goPaths, source),
  ]);
  const sources = [...lcovSources, ...goSources];
  sources.sort((a, b) => comparePaths(a.digest, b.digest));
  return { text: sources.map(source => source.text).join('\n'), inputDigests: sources.map(source => source.digest) };
}

function paths(input: LcovFiles | undefined): readonly string[] {
  return typeof input === 'string' ? [input] : input ?? [];
}

async function readGoCoverFiles(files: readonly string[], source: CoverageSource) {
  if (files.length === 0) return [];
  const [goSource, inputs] = await Promise.all([goCoverSource(source), Promise.all(files.map(readInput))]);
  return inputs.map((input, index) => ({ ...input, text: goCoverToLcov(input.text, files[index]!, goSource) }));
}

async function readInput(path: string) {
  const text = utf8(await readFile(path));
  return { text, digest: digest(text) };
}
