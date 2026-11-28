import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { normalizeProfile } from '@repometry/core/internal/profile/profile.js';
import type { Component } from '../report/json/wire/component-model.js';
import type { Invocation } from './arguments.js';
import { readPluginReferences } from '../compose/plugin-reference.js';
import { distributionParsers } from '../compose/distribution.js';
import type { Distribution } from '../compose/distribution.js';
import { loadPlugins } from '../compose/load-plugins.js';
import { languageRegistry } from '../compose/languages.js';
import { registeredPlugins } from '../compose/built-ins.js';
import { readParserOrder, selectParsers } from '../compose/parser-order.js';
import { invocationDirectory } from './store.js';

const keys = new Set(['$schema', 'exclude', 'ignore', 'imports', 'reports', 'source', 'branch',
  'minCoverage', 'minLines', 'maxNewIssues', 'plugins', 'components', 'parsers']);

export function parseConfig(value: unknown, distribution?: Distribution) {
  if (!isRecord(value)) throw new Error('Config must be an object');
  if (Object.hasOwn(value, 'sources')) throw new Error('Config sources is renamed. Write source.');
  const unknown = Object.keys(value).find(key => !keys.has(key));
  if (unknown !== undefined) throw new Error('Config /' + unknown + ' is not a supported field');
  string(value.$schema, '$schema');
  const profile = normalizeProfile({ exclude: value.exclude, ignore: value.ignore });
  const plugins = readPluginReferences(value.plugins);
  const parsers = readParserOrder(value.parsers, 'Config parsers');
  if (!plugins.length && parsers !== undefined) {
    languageRegistry(distribution?.bundled ?? [], distributionParsers(distribution, parsers), 'Config parsers');
  }
  return { ...profile, plugins, parsers, imports: list(value.imports, 'imports'), reports: list(value.reports, 'reports'),
    source: string(value.source, 'source'), branch: string(value.branch, 'branch'),
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

export async function readConfig(root: string, input: Invocation, metadataOnly = false, distribution?: Distribution) {
  return loadConfig(await readConfigValue(root, input), root, configFile(root, input), metadataOnly, distribution);
}

export async function readDisplayConfig(root: string, input: Invocation, distribution?: Distribution) {
  const value = await readConfigValue(root, input);
  try {
    return parseConfig(value, distribution);
  } catch (error) {
    throw configurationError(configFile(root, input), error);
  }
}

export async function loadConfig(value: unknown, root: string, file: string | undefined, metadataOnly = false,
  distribution?: Distribution) {
  try {
    const { plugins: references, ...config } = parseConfig(value, distribution);
    const plugins = await loadPlugins(references, root, file, metadataOnly, distribution);
    const parsers = distributionParsers(distribution, config.parsers);
    if (metadataOnly) selectParsers(registeredPlugins(plugins), parsers, 'Config parsers');
    else if (plugins.length) languageRegistry(plugins, parsers, 'Config parsers');
    return { ...config, parsers, plugins };
  } catch (error) {
    throw configurationError(file, error);
  }
}

function configurationError(file: string | undefined, error: unknown): unknown {
  if (file === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(file + ': ' + message.replace(/^Config /, ''), { cause: error });
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
    throw configurationError(file, error);
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw configurationError(file, error);
  }
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
  const valid = typeof value === 'number' && value >= 0
    && (max === undefined ? Number.isSafeInteger(value) : value <= max);
  if (!valid) {
    const expected = max === undefined ? 'a non-negative integer' : 'a number from 0 to ' + max;
    throw new Error('Config ' + key + ' must be ' + expected);
  }
  return value;
}

function parseComponents(config: unknown): readonly Component[] {
  if (config === undefined) return [];
  if (!Array.isArray(config)) throw new Error('Config components must be an array');
  const names = new Set<string>();
  return config.map((entry: unknown, index: number) => {
    const base = 'Config components/' + index;
    const { name, include, description } = componentFields(entry, base);
    if (names.has(name)) throw new Error(base + '/name duplicates ' + name);
    names.add(name);
    return { name, pathGlobs: [...new Set(include)], description };
  });
}

function componentFields(entry: unknown, base: string) {
  if (!isRecord(entry)) throw new Error(base + ' must be an object');
  if (Object.hasOwn(entry, 'pathGlobs')) throw new Error(base + '/pathGlobs is renamed. Write include.');
  const unknown = Object.keys(entry).find(key => !['name', 'include', 'description'].includes(key));
  if (unknown !== undefined) throw new Error(base + '/' + unknown + ' is not a supported field');
  const { name, include, description } = entry;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error(base + '/name must be between 1 and 100 characters');
  if (!Array.isArray(include) || include.length === 0 || !include.every(validPattern)) {
    throw new Error(base + '/include must specify repository-relative include globs');
  }
  if (description !== undefined && typeof description !== 'string') throw new Error(base + '/description must be a string');
  return { name: name.trim(), include: include as readonly string[], description };
}

function validPattern(pattern: unknown): pattern is string {
  return typeof pattern === 'string' && !/^[A-Za-z]:|[\\\0]/.test(pattern)
    && pattern.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
