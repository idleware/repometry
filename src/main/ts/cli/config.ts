import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isRecord } from '../core/engine/plugin.js';
import { normalizeProfile } from '../core/profile/profile.js';
import type { Component } from '../report/json/wire/component-model.js';
import type { Invocation } from './arguments.js';
import { readProcessPlugins } from '../compose/process-plugins.js';
import { invocationDirectory } from './store.js';

const keys = new Set(['$schema', 'exclude', 'ignore', 'imports', 'reports', 'sources', 'branch',
  'minCoverage', 'minLines', 'maxNewIssues', 'plugins', 'components']);

export function parseConfig(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.has(key))) throw new Error('Invalid Repometry JSON configuration');
  string(value.$schema, '$schema');
  const profile = normalizeProfile({ exclude: value.exclude, ignore: value.ignore });
  return { ...profile, plugins: readProcessPlugins(value.plugins), imports: list(value.imports, 'imports'), reports: list(value.reports, 'reports'),
    sources: string(value.sources, 'sources'), branch: string(value.branch, 'branch'),
    components: parseComponents(value.components),
    minCoverage: number(value.minCoverage, 'minCoverage', 100), minLines: number(value.minLines, 'minLines'),
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

export function listOption(input: Invocation, name: string, configured: readonly string[]): readonly string[] {
  const typed = input.many(name);
  return typed.length ? typed : configured;
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

function number(value: unknown, key: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || value < 0 || (max === undefined
    ? !Number.isSafeInteger(value) : !Number.isFinite(value) || value > max)) {
    throw new Error('Invalid config ' + key + (max === undefined ? ': expected a non-negative integer' : ': expected a number from 0 to ' + max));
  }
  return value;
}

function parseComponents(config: unknown): readonly Component[] {
  if (config === undefined) return [];
  if (!Array.isArray(config)) throw new Error('Expected an array of component definitions');
  const names = new Set<string>();
  return config.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100
      || !Array.isArray(entry.pathGlobs) || entry.pathGlobs.length === 0 || !entry.pathGlobs.every(validPattern)
      || (entry.description !== undefined && typeof entry.description !== 'string')) {
      throw new Error('Each component requires a name and one or more root-relative pathGlobs');
    }
    const name = entry.name.trim();
    if (names.has(name)) throw new Error(`Duplicate component name: ${name}`);
    names.add(name);
    return { name, pathGlobs: [...new Set(entry.pathGlobs)], description: entry.description };
  });
}

function validPattern(pattern: unknown): pattern is string {
  return typeof pattern === 'string' && !/^[A-Za-z]:|[\\\0]/.test(pattern)
    && pattern.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
