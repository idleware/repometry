import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import historyContract from '../../../../resources/report/json/public-history-v1.schema.json' with { type: 'json' };
import qualityContract from '../../../../resources/report/json/quality-history-v1.schema.json' with { type: 'json' };
import type { QualitySummary } from '../../../core/model/quality-summary.js';
import type { PublicHistory, PublicHistoryEntry, QualityHistory } from '../../json/wire/public-history-model.js';
import { withoutFooter } from './export-site.js';

import type { ProjectEntry } from '../../json/wire/project-model.js';

const indexMarker = '<meta name="repometry-projects" content="1">';
const resources = '../../../../resources/viewer/';
const validator = new Ajv2020();
const validHistory = validator.compile<PublicHistory>(historyContract);
const validQuality = validator.compile<QualityHistory>(qualityContract);

export async function exportProjects(directory: string, { footer = true }: { readonly footer?: boolean } = {}): Promise<number> {
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
    ['index.html', await readFile(new URL(resources + 'projects.html', import.meta.url))
      .then(page => footer ? page : Buffer.from(withoutFooter(page.toString('utf8'))))],
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
  const path = join(directory, name);
  const text = await readOptional(join(path, 'history.json'));
  if (text === null) return null;
  const history: unknown = JSON.parse(text);
  if (!validHistory(history)) return null;
  const inspection = history.reports[0] ?? null;
  const qualityText = inspection && await readOptional(join(path, 'quality-history.json'));
  const quality: unknown = qualityText ? JSON.parse(qualityText) : null;
  return { name, inspection, quality: inspection && validQuality(quality)
    ? quality.reports[inspection.sha] ?? null : null };
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
