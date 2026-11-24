import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isRecord } from '../../../core/engine/plugin.js';
import { unpackJson } from '../../json/wire/compact-json.js';
import { validateSummaryIndex } from '../../json/validation/summary-validation.js';
import { serveAssets } from './server.js';
import { sourceResponse } from './source-route.js';
import type { SourceAccess } from './source-route.js';

export async function readExportedSummary(directory: string) {
  const path = join(directory, 'summary.json');
  const index = join(directory, 'index.html');
  try {
    if (!(await lstat(index)).isFile() || !(await lstat(path)).isFile()) return undefined;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validateSummaryIndex(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || missing(error)) return undefined;
    throw error;
  }
}

export async function serveExportedSite(directory: string, port: number, access?: SourceAccess) {
  const root = await realpath(directory);
  const summary = await readExportedSummary(root);
  if (!summary) throw new Error(`No exported report at ${directory}`);
  const details = new Map(summary.commits.map(row => [row.sha, row.detail]));
  const local = summary.sources?.provider === 'local' && summary.sources.url === './sources/{revision}/{path}' ? access : undefined;

  async function file(name: string): Promise<Buffer | undefined> {
    if (name !== 'summary.json' && name !== 'pulls.json' && !/^[A-Za-z0-9_-]+\.(?:html|css|js|svg)$/.test(name)
      && !/^details\/[a-f0-9]+-[a-f0-9]{64}\.json$/.test(name)) {
      return undefined;
    }
    const path = join(root, name);
    try {
      if (!(await lstat(path)).isFile() || !((await realpath(path)).startsWith(root + sep))) return undefined;
      return readFile(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  return serveAssets(port, async name => {
    if (!name.startsWith('sources/')) return file(name);
    return sourceResponse(name, local, async (revision, path) => {
      const detail = details.get(revision);
      if (!detail?.startsWith(`details/${revision}-`)) return false;
      const bytes = await file(detail);
      if (!bytes) return false;
      const asset = unpackJson(JSON.parse(bytes.toString('utf8')) as unknown);
      if (!isRecord(asset) || asset.schema !== 'urn:repometry:schema:viewer-inspection:1'
        || asset.sha !== revision || !isRecord(asset.inspection)) return false;
      const { metrics, findings, diagnostics } = asset.inspection;
      return (isRecord(metrics) && listsPath(metrics.files, path)) || listsPath(findings, path) || listsPath(diagnostics, path);
    });
  }, access?.close);
}

function listsPath(rows: unknown, path: string): boolean {
  return Array.isArray(rows) && rows.some(row => isRecord(row) && row.path === path);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
