import { isRecord } from '../../../core/model/plugin-data.js';
import { comparePaths, digest } from '../../../core/model/snapshot.js';

/**
 * A saved report keeps per-file rows in content-addressed objects, so an unchanged file version is stored once
 * however many commits share it. The commit file keeps the rest of the report and the row order.
 */
export const storedReportSchema = 'urn:repometry:schema:report-store:1';

type Row = Readonly<Record<string, unknown>>;
type FileNode = Record<string, Row[][]>;
type Directory = Map<string, Directory | FileNode>;

/** Reads verified, parsed objects in the order of `ids`. */
export interface ObjectSource {
  read(ids: readonly string[]): Promise<readonly unknown[]>;
}

export interface StoredReport {
  readonly profile: string;
  readonly tree: string;
  readonly report: Readonly<Record<string, unknown>>;
}

/** Applied configuration that describes one commit rather than the profile, kept in the commit file. */
const commitConfig = ['churnWindow'];
const idPattern = /^[a-f0-9]{32}-[a-f0-9]{8}$/;

export function objectId(text: string): string {
  return digest(text).slice(0, 32);
}

/**
 * An object's name: the ID of its content, then a hint from the path it describes. Objects stay plain JSON, so Git
 * compresses them and stores a new version as a small difference from the last. Git finds the last version by the
 * end of the file name and by its folder, so every version of one path's object ends alike and shares a folder.
 */
function objectName(text: string, path: string): string {
  return `${objectId(text)}-${digest(path).slice(0, 8)}`;
}

export function objectPath(id: string): string {
  if (!idPattern.test(id)) throw new Error(`Invalid report object ID: ${id}`);
  return `objects/${id.slice(33, 35)}/${id}.json`;
}

export class ObjectError extends Error {
  constructor(readonly id: string, readonly reason: 'missing' | 'corrupt') {
    super(`Report object ${id} is ${reason}. Run repometry store check --repair, or analyze the commit again.`);
  }
}

/** Reads an object and checks its content against its ID. */
export function objectText(id: string, bytes: Uint8Array | undefined): string {
  const text = present(id, bytes);
  if (objectId(text) !== id.slice(0, 32)) throw new ObjectError(id, 'corrupt');
  return text;
}

function present(id: string, bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw new ObjectError(id, 'missing');
  return Buffer.from(bytes).toString('utf8');
}

function parsed(id: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ObjectError(id, 'corrupt');
  }
}

/** Object texts read recently, up to `limit` characters; the oldest go first. Objects never change, so any reader may share it. */
export class ObjectCache {
  private readonly texts = new Map<string, string>();
  private size = 0;

  constructor(private readonly limit = 64 * 1024 * 1024) {}

  get(id: string): string | undefined {
    return this.texts.get(id);
  }

  set(id: string, text: string): void {
    if (this.texts.has(id)) return;
    this.texts.set(id, text);
    this.size += text.length;
    for (const [oldest, value] of this.texts) {
      if (this.size <= this.limit) break;
      this.texts.delete(oldest);
      this.size -= value.length;
    }
  }
}

/**
 * An object source over stored bytes, for reading reports: each report's revision check covers the content of its
 * objects, so reads skip hashing them. Values are parsed per read, so reports never share mutable rows.
 */
export function storedObjects(load: (ids: readonly string[]) => Promise<readonly (Uint8Array | undefined)[]>,
  cache = new ObjectCache(0)): ObjectSource {
  return {
    async read(ids) {
      const cached = new Map(ids.flatMap(id => {
        const text = cache.get(id);
        return text === undefined ? [] : [[id, text] as const];
      }));
      const wanted = [...new Set(ids)].filter(id => !cached.has(id));
      const bytes = await load(wanted);
      const loaded = new Map(wanted.map((id, position) => [id, present(id, bytes[position])]));
      const values = ids.map(id => parsed(id, cached.get(id) ?? loaded.get(id)!));
      // Only texts that parsed are kept, so a damaged object is read afresh once repaired.
      for (const [id, text] of loaded) cache.set(id, text);
      return values;
    },
  };
}

/** Splits a report into the commit record and the objects it references. */
export function splitReport(report: Row): { readonly stored: StoredReport; readonly objects: ReadonlyMap<string, string> } {
  const objects = new Map<string, string>();
  const put = (value: unknown, path: string): string => {
    const text = JSON.stringify(value);
    const id = objectName(text, path);
    objects.set(id, text);
    return id;
  };
  const lists: [string, readonly Row[]][] = [];
  const catalog: Record<string, unknown> = {};
  mapParts(report, {
    list: (slot, rows) => Array.isArray(rows) && lists.push([slot, rows]),
    config: () => undefined, definitions: () => undefined, catalog: (key, value) => catalog[key] = value,
  });
  const namedPaths = new Set<string>();
  for (const [, rows] of lists) {
    for (const { path } of rows) if (typeof path === 'string') namedPaths.add(path);
  }
  const paths = [...namedPaths].sort(comparePaths);
  const index = new Map(paths.map((path, position) => [path, position]));
  const nodes = paths.map((): FileNode => ({}));
  const entries = new Map(lists.map(([slot, rows]) => [slot, liftRows(rows, slot, index, nodes)]));
  const config = isRecord(report.appliedConfig) ? report.appliedConfig : {};
  const profile = put({
    appliedConfig: mapEntries(config, (key, value) => commitConfig.includes(key) ? null : value),
    definitions: report.definitions,
    ...(isRecord(report.pluginData) ? { catalog } : {}),
  }, '');
  const stored = mapParts(report, {
    list: (slot, rows) => entries.get(slot) ?? rows,
    config: () => Object.fromEntries(Object.entries(config).filter(([key]) => commitConfig.includes(key))),
    definitions: () => null, catalog: () => null,
  });
  return { stored: { profile, tree: writeDirectory(directoryOf(paths, nodes), put, '/'), report: stored }, objects };
}

/** Rebuilds the exact report a commit record was split from. */
export async function rebuildReport(stored: unknown, source: ObjectSource): Promise<Readonly<Record<string, unknown>>> {
  if (!isRecord(stored) || typeof stored.profile !== 'string' || typeof stored.tree !== 'string' || !isRecord(stored.report)) {
    throw new Error('Invalid stored report');
  }
  const [[profile], files] = await Promise.all([source.read([stored.profile]), readTree(stored.tree, source)]);
  const config = isRecord(profile) ? profile.appliedConfig : undefined;
  if (!isRecord(profile) || !isRecord(config)) throw new Error('Invalid stored report profile');
  const catalog = isRecord(profile.catalog) ? profile.catalog : {};
  return mapParts(stored.report, {
    list: rowExpander(files),
    config: value => ({ ...config, ...(isRecord(value) ? value : {}) }),
    definitions: () => profile.definitions,
    catalog: (key, value) => Object.hasOwn(catalog, key) ? catalog[key] : value,
  });
}

interface Parts {
  /** A list whose rows may name a file, under the slot its rows take in file objects. */
  list(slot: string, rows: unknown): unknown;
  config(value: unknown): unknown;
  definitions(value: unknown): unknown;
  /** A plugin catalog entry: everything in plugin data besides products and inventory. */
  catalog(key: string, value: unknown): unknown;
}

/** The one place that knows which parts of a report are per file, per profile or per commit. */
function mapParts(report: Readonly<Record<string, unknown>>, parts: Parts): Record<string, unknown> {
  return mapEntries(report, (key, value) => {
    if (key === 'appliedConfig') return parts.config(value);
    if (key === 'definitions') return parts.definitions(value);
    if (key === 'measurements' || key === 'findings' || key === 'ruleSkips') return parts.list(key, value);
    if (key !== 'pluginData' || !isRecord(value)) return value;
    return mapEntries(value, (name, item) => name === 'products'
      ? isRecord(item) ? mapEntries(item, (contract, rows) => parts.list(`products/${contract}`, rows)) : item
      : name === 'inventory' ? parts.list(name, item) : parts.catalog(name, item));
  });
}

/** Moves file rows into their file nodes. Each run of one file's rows becomes a [file, count] range entry. */
function liftRows(rows: readonly Row[], slot: string, index: ReadonlyMap<string, number>, nodes: FileNode[]): unknown[] {
  const entries: unknown[] = [];
  let last: number | undefined;
  for (const row of rows) {
    const file = typeof row.path === 'string' ? index.get(row.path) : undefined;
    if (file === undefined) {
      entries.push(row);
      last = undefined;
      continue;
    }
    const runs = nodes[file]![slot] ??= [];
    if (file !== last) {
      runs.push([]);
      const previous = entries.at(-1);
      if (Array.isArray(previous) && previous[0] + previous[1] === file) previous[1]++;
      else entries.push([file, 1]);
      last = file;
    }
    // Keep the key order of the row; the path comes back from the tree.
    runs.at(-1)!.push({ ...row, path: 0 });
  }
  return entries;
}

function rowExpander(files: ReadonlyMap<string, FileNode>): (slot: string, entries: unknown) => unknown {
  const paths = [...files.keys()].sort(comparePaths);
  const cursors = new Map<string, number>();
  const run = (file: number, slot: string): Row[] => {
    const key = `${slot}\n${file}`;
    const position = cursors.get(key) ?? 0;
    cursors.set(key, position + 1);
    const path = paths[file]!;
    const rows = files.get(path)?.[slot]?.[position];
    if (!Array.isArray(rows) || !rows.every(isRecord)) throw new Error('Invalid stored report rows');
    // Rows come freshly parsed for this report; the path takes the place its placeholder holds.
    for (const row of rows as Record<string, unknown>[]) row.path = path;
    return rows;
  };
  return (slot, entries) => {
    if (!Array.isArray(entries)) return entries;
    return entries.flatMap(entry => {
      if (!Array.isArray(entry)) return [entry];
      const [first, count] = entry as unknown[];
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || (first as number) < 0 || (count as number) < 1
        || (first as number) + (count as number) > paths.length) throw new Error('Invalid stored report rows');
      return Array.from({ length: count as number }, (_, offset) => run((first as number) + offset, slot)).flat();
    });
  };
}

function directoryOf(paths: readonly string[], nodes: readonly FileNode[]): Directory {
  const root: Directory = new Map();
  paths.forEach((path, position) => {
    const parts = path.split('/');
    const name = parts.pop()!;
    let directory = root;
    for (const part of parts) {
      let child = directory.get(`${part}/`);
      if (!(child instanceof Map)) directory.set(`${part}/`, child = new Map());
      directory = child;
    }
    directory.set(name, nodes[position]!);
  });
  return root;
}

/** Writes a directory as sorted [name, entry] pairs. A file keeps its inventory inline and its other rows in one object. */
function writeDirectory(directory: Directory, put: (value: unknown, path: string) => string, path: string): string {
  return put([...directory].sort(([a], [b]) => comparePaths(a, b)).map(([name, value]) => {
    if (value instanceof Map) return [name, writeDirectory(value, put, path + name)];
    const { inventory, ...rows } = value;
    return [name, { ...(inventory ? { inventory } : {}), ...(Object.keys(rows).length ? { data: put(rows, path + name) } : {}) }];
  }), path);
}

async function readTree(root: string, source: ObjectSource): Promise<Map<string, FileNode>> {
  const files = new Map<string, FileNode>();
  const data: [string, string][] = [];
  let level: [string, string][] = [['', root]];
  while (level.length) {
    const directories = await source.read(level.map(([, id]) => id));
    const next: [string, string][] = [];
    level.forEach(([prefix], position) => {
      const entries = directories[position];
      if (!Array.isArray(entries)) throw new Error('Invalid stored report tree');
      for (const entry of entries) {
        const [name, value] = Array.isArray(entry) ? entry as unknown[] : [];
        if (typeof name !== 'string') throw new Error('Invalid stored report tree');
        const path = prefix + name;
        if (name.endsWith('/') && typeof value === 'string') next.push([path, value]);
        else if (!name.endsWith('/') && isRecord(value)) {
          files.set(path, Array.isArray(value.inventory) ? { inventory: value.inventory as Row[][] } : {});
          if (typeof value.data === 'string') data.push([path, value.data]);
        } else throw new Error('Invalid stored report tree');
      }
    });
    level = next;
  }
  const loaded = await source.read(data.map(([, id]) => id));
  data.forEach(([path], position) => {
    const rows = loaded[position];
    if (!isRecord(rows)) throw new Error('Invalid stored report file');
    files.set(path, { ...files.get(path), ...rows as FileNode });
  });
  return files;
}

function mapEntries(value: Readonly<Record<string, unknown>>, map: (key: string, item: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(key, item)]));
}
