import { readFile } from 'node:fs/promises';
import { comparePaths, digest, utf8 } from '../../core/model/snapshot.js';
import { coberturaToLcov } from './cobertura.js';
import { goCoverSource, goCoverToLcov } from './go-cover.js';
import type { CoverageSource } from './go-cover.js';

export type LcovFiles = string | readonly string[];

export interface CoverageInputs {
  readonly lcov?: LcovFiles;
  readonly goCover?: LcovFiles;
  readonly cobertura?: LcovFiles;
}

export function hasCoverageInputs({ lcov, goCover, cobertura }: CoverageInputs): boolean {
  return lcov !== undefined || goCover !== undefined || cobertura !== undefined;
}

export async function readCoverageFiles({ lcov, goCover, cobertura }: CoverageInputs, source: CoverageSource) {
  const lcovPaths = paths(lcov);
  const goPaths = paths(goCover);
  const coberturaPaths = paths(cobertura);
  if (lcov !== undefined && lcovPaths.length === 0) throw new Error('Provide at least one LCOV file');
  if (goCover !== undefined && goPaths.length === 0) throw new Error('Provide at least one Go coverprofile');
  if (cobertura !== undefined && coberturaPaths.length === 0) throw new Error('Provide at least one Cobertura file');
  if (lcovPaths.length === 0 && goPaths.length === 0 && coberturaPaths.length === 0) throw new Error('Provide at least one coverage input');
  const [lcovSources, goSources, coberturaSources] = await Promise.all([
    Promise.all(lcovPaths.map(readInput)),
    readGoCoverFiles(goPaths, source),
    Promise.all(coberturaPaths.map(file => readCobertura(file, source))),
  ]);
  const sources = [...lcovSources, ...goSources, ...coberturaSources];
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

async function readCobertura(path: string, source: CoverageSource) {
  const bytes = await readFile(path);
  let text: string;
  try {
    text = utf8(bytes);
  } catch (error) {
    throw new Error('Invalid Cobertura report ' + path + ' at line 1: invalid UTF-8', { cause: error });
  }
  return { text: coberturaToLcov(text, path, source), digest: digest(text) };
}

async function readInput(path: string) {
  const text = utf8(await readFile(path));
  return { text, digest: digest(text) };
}
