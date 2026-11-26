import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readExportedSummary } from './exported-server.js';

import type { ProjectEntry } from '../../json/wire/project-model.js';

const indexMarker = '<meta name="repometry-projects" content="1">';
const resources = '../../../../resources/viewer/';
export async function exportProjects(directory: string): Promise<number> {
  const folders = await readdir(directory, { withFileTypes: true });
  const candidates = folders.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'));
  const entries = (await Promise.all(candidates.map(({ name }) => readProject(directory, name))))
    .filter(entry => entry !== null);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const marker = await readOptional(join(directory, 'index.html'));
  const files = new Map<string, string | Buffer>([
    ['styles.css', await readFile(new URL(resources + 'styles.css', import.meta.url))],
    ['projects.js', await readFile(new URL('../app/viewer-projects.js', import.meta.url))],
    ['projects.json', JSON.stringify({ schema: 'urn:repometry:schema:projects:1', projects: entries }) + '\n'],
    ['index.html', await readFile(new URL(resources + 'projects.html', import.meta.url))],
  ]);
  if (marker !== null && !marker.includes(indexMarker)) throw new Error('Directory already contains another site index');
  for (const name of files.keys()) {
    try {
      const file = await lstat(join(directory, name));
      if (!file.isFile() || marker === null) throw new Error(`Project index would overwrite ${name}`);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
  const staging = join(directory, `.projects-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const [name, contents] of files) await writeFile(join(staging, name), contents);
    for (const name of files.keys()) await rename(join(staging, name), join(directory, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return entries.length;
}

async function readProject(directory: string, name: string): Promise<ProjectEntry | null> {
  const summary = await readExportedSummary(join(directory, name));
  if (!summary) return null;
  const latest = summary.commits[0];
  if (!latest) return { name, inspection: null, quality: null };
  const { quality, counts, detail, revision, profileDigest, profileBoundary, metrics, values, privateMetrics, ...inspection } = latest;
  return { name, inspection, quality };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return null;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
