import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { satisfies, validRange } from 'semver';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import type { PluginManifest } from '@repometry/core/internal/engine/plugin-manifest.js';

type Requirements = NonNullable<PluginManifest['requires']>;
const packageFile = new URL('../../../../package.json', import.meta.url);
const hostVersions = new Map<string, Promise<string>>();
const versionFields = ['node', 'repometry'] as const;

export function readRequirements(value: unknown, field: string): Requirements {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(key => !['node', 'repometry', 'tools'].includes(key))) {
    throw new Error(field + ' must declare node, repometry or tools');
  }
  const ranges = Object.fromEntries(versionFields.flatMap(key => {
    const range = value[key];
    if (range === undefined) return [];
    if (typeof range !== 'string' || !range.trim() || validRange(range) === null) {
      throw new Error(field + '/' + key + ' must be a semver range');
    }
    return [[key, range]];
  }));
  const tools = value.tools;
  if (tools === undefined) return ranges;
  if (!Array.isArray(tools) || !tools.every(executableName) || new Set(tools).size !== tools.length) {
    throw new Error(field + '/tools must be a list of unique executable names');
  }
  return { ...ranges, tools };
}

function executableName(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s/\\\0]+$/.test(value) && !['.', '..'].includes(value);
}

export async function unmetRequirement({ node, repometry, tools = [] }: Requirements,
  packageUrl = packageFile.href): Promise<string | undefined> {
  if (node !== undefined && !satisfies(process.version, node)) return 'requires Node.js ' + node + ', found ' + process.version;
  if (repometry !== undefined) {
    const version = await hostVersion(packageUrl);
    if (!satisfies(version, repometry)) return 'requires Repometry ' + repometry + ', found ' + version;
  }
  for (const tool of tools) {
    if (!await executableOnPath(tool)) return 'required executable ' + tool + ' is not on PATH';
  }
  return undefined;
}

function hostVersion(packageUrl: string): Promise<string> {
  const cached = hostVersions.get(packageUrl);
  if (cached !== undefined) return cached;
  const pending = readFile(new URL(packageUrl), 'utf8').then(json => (JSON.parse(json) as { version: string }).version);
  hostVersions.set(packageUrl, pending);
  return pending;
}

async function executableOnPath(name: string): Promise<boolean> {
  const windows = process.platform === 'win32';
  const extensions = windows ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const directories = (process.env.PATH ?? '').split(delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory, name + extension);
      if (await isExecutableFile(candidate, windows)) return true;
    }
  }
  return false;
}

async function isExecutableFile(path: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (isRecord(error) && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))) return false;
    throw error;
  }
}
