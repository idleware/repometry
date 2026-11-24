import { isRecord } from '../../core/engine/plugin.js';
import type { AnalysisInput } from '../../core/usecases/inspect.js';
import { validSubjectId } from '../../report/json/validation/report.js';
import { exclusionMatcher, normalizeExclusions, sourceExclusionMatcher } from '../../core/profile/exclusions.js';
import { comparePaths, isExcludedDirectory, workingSnapshot } from '../../core/model/snapshot.js';
import type { SourceFile, Subject } from '../../core/model/snapshot.js';
import { isClaimedText } from '../../core/model/source.js';
import type { InventoryFile } from '../../core/model/source.js';

const schemaV1 = 'urn:repometry:schema:worker-input:1';
const schemaV2 = 'urn:repometry:schema:worker-input:2';
const schemaV3 = 'urn:repometry:schema:worker-input:3';
export const workerRoute = '/v1/inspect';
export const maxWorkerInput = 16 * 1024 * 1024;
export const maxWorkerResult = 64 * 1024 * 1024;

export function workerToken(value = process.env.REPOMETRY_WORKER_TOKEN): string {
  if (!value || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('Set REPOMETRY_WORKER_TOKEN before using the worker');
  return value;
}

export function encodeWorkerInput(input: AnalysisInput, isSource: (path: string) => boolean): string {
  const { subject, files, inventory, generatedExcluded, oversizedClaims } = input.snapshot;
  const excludedPaths = input.excludedPaths ?? [];
  const hasClaims = oversizedClaims?.length || files.some(file => !isSource(file.path));
  const profile = hasClaims ? { schema: schemaV3, excludedPaths, oversizedClaims: oversizedClaims ?? [] }
    : excludedPaths.length === 0 ? { schema: schemaV1 } : { schema: schemaV2, excludedPaths };
  return JSON.stringify({ ...profile, subject, excludedOutput: input.excludedOutput, coverage: input.coverage ?? null,
    files: files.map(({ path, bytes }) => ({ path, base64: Buffer.from(bytes).toString('base64') })),
    ...(inventory === undefined ? {} : { inventory }), ...(generatedExcluded?.length ? { generatedExcluded } : {}) });
}

export function decodeWorkerInput(value: unknown, isSource: (path: string) => boolean): AnalysisInput {
  if (!isRecord(value) || (value.schema !== schemaV1 && value.schema !== schemaV2 && value.schema !== schemaV3)
    || !isSubject(value.subject) || !Array.isArray(value.files)) {
    throw new Error('Invalid worker input envelope');
  }
  const { subject, excludedOutput } = value;
  const excludedPaths = value.schema === schemaV1 ? [] : normalizeExclusions(value.excludedPaths);
  const excludes = value.schema === schemaV3 ? sourceExclusionMatcher(excludedPaths) : exclusionMatcher(excludedPaths);
  if (excludedOutput !== null && (typeof excludedOutput !== 'string' || !safePath(excludedOutput))) throw new Error('Invalid excluded output');
  if (subject.kind === 'commit' && excludedOutput !== null) throw new Error('Invalid excluded output for the Git snapshot');
  const files: SourceFile[] = [];
  const paths = new Set<string>();
  for (const item of value.files as unknown[]) {
    if (!isRecord(item) || typeof item.path !== 'string' || !safePath(item.path) || excludes(item.path)
      || typeof item.base64 !== 'string') {
      throw new Error('Invalid worker source file');
    }
    if (paths.has(item.path)) throw new Error('Duplicate worker source path');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64) throw new Error('Invalid worker source encoding');
    if (!isSource(item.path) && (value.schema !== schemaV3 || !isClaimedText(bytes) || excludedParent(item.path))) {
      throw new Error('Invalid worker claimed file');
    }
    paths.add(item.path);
    files.push({ path: item.path, bytes });
  }
  if (subject.kind === 'working-tree' && workingSnapshot(files).subject.id !== subject.id) {
    throw new Error('Invalid working snapshot digest');
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const inventory = readInventory(value.inventory, excludes);
  const generatedExcluded = readGeneratedExclusions(value.generatedExcluded, paths, isSource, inventory);
  const oversizedClaims = value.schema === schemaV3 ? readOversizedClaims(value.oversizedClaims, paths, excludes) : [];
  return { snapshot: { subject, files, ...(inventory === undefined ? {} : { inventory }), generatedExcluded,
    ...(oversizedClaims.length ? { oversizedClaims } : {}) },
    excludedOutput, excludedPaths, coverage: readCoverage(value.coverage) };
}

function readOversizedClaims(value: unknown, paths: ReadonlySet<string>, excludes: (path: string) => boolean): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid worker oversized claims');
  const claimed = new Set<string>();
  for (const path of value as unknown[]) {
    if (typeof path !== 'string' || !safePath(path) || excludedParent(path) || excludes(path) || paths.has(path)) {
      throw new Error('Invalid worker oversized claim');
    }
    claimed.add(path);
  }
  return [...claimed].sort(comparePaths);
}

function excludedParent(path: string): boolean {
  return path.split('/').slice(0, -1).some(isExcludedDirectory);
}

function readGeneratedExclusions(value: unknown, sourcePaths: ReadonlySet<string>, isSource: (path: string) => boolean,
  inventory?: readonly InventoryFile[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid worker generated exclusions');
  const listed = new Set([...sourcePaths, ...(inventory ?? []).map(file => file.path)]);
  const excluded = new Set<string>();
  for (const path of value as unknown[]) {
    if (typeof path !== 'string' || !safePath(path) || !isSource(path) || listed.has(path) || excluded.has(path)) {
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
