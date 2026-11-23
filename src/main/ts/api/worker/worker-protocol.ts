import { isRecord } from '../../core/engine/plugin.js';
import type { AnalysisInput } from '../../core/usecases/inspect.js';
import { validSubjectId } from '../../report/json/validation/report.js';
import { exclusionMatcher, normalizeExclusions } from '../../core/profile/exclusions.js';
import { comparePaths, isSourcePath, workingSnapshot } from '../../core/model/snapshot.js';
import type { SourceFile, Subject } from '../../core/model/snapshot.js';
import type { InventoryFile } from '../../core/model/source.js';

const schemaV1 = 'urn:repometry:schema:worker-input:1';
const schemaV2 = 'urn:repometry:schema:worker-input:2';
export const workerRoute = '/v1/inspect';
export const maxWorkerInput = 16 * 1024 * 1024;
export const maxWorkerResult = 64 * 1024 * 1024;

export function workerToken(value = process.env.REPOMETRY_WORKER_TOKEN): string {
  if (!value || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('Set REPOMETRY_WORKER_TOKEN before using the worker');
  return value;
}

export function encodeWorkerInput(input: AnalysisInput): string {
  const { subject, files, inventory, generatedExcluded } = input.snapshot;
  const excludedPaths = input.excludedPaths ?? [];
  const profile = excludedPaths.length === 0 ? { schema: schemaV1 } : { schema: schemaV2, excludedPaths };
  return JSON.stringify({ ...profile, subject, excludedOutput: input.excludedOutput, coverage: input.coverage ?? null,
    files: files.map(({ path, bytes }) => ({ path, base64: Buffer.from(bytes).toString('base64') })),
    ...(inventory === undefined ? {} : { inventory }), ...(generatedExcluded?.length ? { generatedExcluded } : {}) });
}

export function decodeWorkerInput(value: unknown): AnalysisInput {
  if (!isRecord(value) || (value.schema !== schemaV1 && value.schema !== schemaV2) || !isSubject(value.subject) || !Array.isArray(value.files)) {
    throw new Error('Invalid worker input envelope');
  }
  const { subject, excludedOutput } = value;
  const excludedPaths = value.schema === schemaV2 ? normalizeExclusions(value.excludedPaths) : [];
  const excludes = exclusionMatcher(excludedPaths);
  if (excludedOutput !== null && (typeof excludedOutput !== 'string' || !safePath(excludedOutput))) throw new Error('Invalid excluded output');
  if (subject.kind === 'commit' && excludedOutput !== null) throw new Error('Invalid excluded output for the Git snapshot');
  const files: SourceFile[] = [];
  const paths = new Set<string>();
  for (const item of value.files as unknown[]) {
    if (!isRecord(item) || typeof item.path !== 'string' || !safePath(item.path) || !isSourcePath(item.path) || excludes(item.path)
      || typeof item.base64 !== 'string') {
      throw new Error('Invalid worker source file');
    }
    if (paths.has(item.path)) throw new Error('Duplicate worker source path');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64) throw new Error('Invalid worker source encoding');
    paths.add(item.path);
    files.push({ path: item.path, bytes });
  }
  if (subject.kind === 'working-tree' && workingSnapshot(files).subject.id !== subject.id) {
    throw new Error('Invalid working snapshot digest');
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const inventory = readInventory(value.inventory, excludes);
  const generatedExcluded = readGeneratedExclusions(value.generatedExcluded, paths, inventory);
  return { snapshot: { subject, files, ...(inventory === undefined ? {} : { inventory }), generatedExcluded },
    excludedOutput, excludedPaths, coverage: readCoverage(value.coverage) };
}

function readGeneratedExclusions(value: unknown, sourcePaths: ReadonlySet<string>, inventory?: readonly InventoryFile[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid worker generated exclusions');
  const listed = new Set([...sourcePaths, ...(inventory ?? []).map(file => file.path)]);
  const excluded = new Set<string>();
  for (const path of value as unknown[]) {
    if (typeof path !== 'string' || !safePath(path) || !isSourcePath(path) || listed.has(path) || excluded.has(path)) {
      throw new Error('Invalid worker generated exclusion');
    }
    excluded.add(path);
  }
  return [...excluded].sort(comparePaths);
}

function readInventory(value: unknown, excludes: (path: string) => boolean): readonly InventoryFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid worker file inventory');
  const inventory = new Map<string, InventoryFile>();
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item.path !== 'string' || !safePath(item.path) || excludes(item.path) || inventory.has(item.path)
      || (item.lines !== null && (typeof item.lines !== 'number' || !Number.isSafeInteger(item.lines) || item.lines < 0))
      || (item.bytes !== undefined && (typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0))) {
      throw new Error('Invalid worker inventory file');
    }
    inventory.set(item.path, { path: item.path, lines: item.lines, ...(item.bytes === undefined ? {} : { bytes: item.bytes as number }) });
  }
  return [...inventory.values()];
}

function isSubject(value: unknown): value is Subject {
  return isRecord(value) && (value.kind === 'commit' || value.kind === 'working-tree') && typeof value.id === 'string' && validSubjectId(value.kind, value.id);
}

function safePath(path: string): boolean {
  return !path.includes('\0') && !path.split('/').some(part => part === '' || part === '.' || part === '..');
}

function readCoverage(value: unknown): AnalysisInput['coverage'] {
  if (value === null) return undefined;
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.sourceRoot !== 'string') throw new Error('Invalid worker LCOV input');
  return { text: value.text, sourceRoot: value.sourceRoot };
}
