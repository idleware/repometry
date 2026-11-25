import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isRecord } from '../core/engine/plugin.js';
import { normalizeProfile } from '../core/profile/profile.js';
import type { Invocation } from './arguments.js';
import { readProcessPlugins } from '../compose/process-plugins.js';
import { invocationDirectory } from './store.js';

const keys = new Set(['$schema', 'exclude', 'ignore', 'imports', 'reports', 'sources', 'branch',
  'minCoverage', 'minLines', 'maxNewIssues', 'plugins']);

export function parseConfig(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.has(key))) throw new Error('Invalid Repometry JSON configuration');
  string(value.$schema, '$schema');
  const profile = normalizeProfile({ exclude: value.exclude, ignore: value.ignore });
  return { ...profile, plugins: readProcessPlugins(value.plugins), imports: list(value.imports, 'imports'), reports: list(value.reports, 'reports'),
    sources: string(value.sources, 'sources'), branch: string(value.branch, 'branch'),
    minCoverage: number(value.minCoverage, 'minCoverage'), minLines: number(value.minLines, 'minLines'),
    maxNewIssues: number(value.maxNewIssues, 'maxNewIssues') };
}

/** The configuration file in effect, or undefined under --no-config. */
export function configFile(root: string, input: Invocation): string | undefined {
  const explicit = input.text('config');
  if (input.flag('no-config')) {
    if (explicit !== undefined) throw new Error('Choose --config or --no-config');
    return undefined;
  }
  return explicit === undefined ? resolve(root, 'repometry.config.json') : resolve(invocationDirectory(input), explicit);
}

export async function readConfig(root: string, input: Invocation) {
  return parseConfig(await readConfigValue(root, input));
}

export async function readConfigValue(root: string, input: Invocation): Promise<unknown> {
  const explicit = input.text('config');
  const file = configFile(root, input);
  if (file === undefined) return {};
  let json: string;
  try {
    json = await readFile(file, 'utf8');
  } catch (error) {
    if (explicit === undefined && error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return JSON.parse(json) as unknown;
}

function list(value: unknown, key: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length > 0)) throw new Error(`Config ${key} must be a string list`);
  return value;
}

function string(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Config ${key} must be a nonempty string`);
  return value;
}

function number(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Config ${key} must be a number`);
  return String(value);
}
