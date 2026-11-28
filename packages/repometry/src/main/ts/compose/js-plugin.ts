import { readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import type { PluginManifest } from '@repometry/core/internal/engine/plugin-manifest.js';
import { checkManifest, dockerFields, manifestPlugin, manifestScope } from './plugin-manifest.js';
import type { PluginReference } from './plugin-reference.js';
import { authorOperation } from './author-operation.js';
import { validatePluginOptions } from './plugin-options.js';
import { readRequirements, unmetRequirement } from './plugin-requirements.js';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const installFrom = new URL('../../../../', import.meta.url);

export interface PluginContext {
  readonly root: string;
  readonly base: string;
  readonly metadataOnly: boolean;
}

export function localModule(path: string, entry: PluginReference, context: PluginContext) {
  if (!/\.[cm]?js$/.test(path)) throw new Error(context.base + ' must reference a JavaScript module or a Docker manifest JSON file');
  return loadJavaScript(pathToFileURL(path).href, entry, context);
}

export function installedModule(name: string, entry: PluginReference, context: PluginContext) {
  const { base } = context;
  if (!packageName.test(name)) throw new Error(base + ' must name an installed npm package');
  let url: string;
  let manifest: string | undefined;
  try {
    url = import.meta.resolve(name);
    if (url.startsWith('file:')) manifest = findPackageJSON(name, import.meta.url);
  } catch (error) {
    throw unresolvedPackage(name, base, error);
  }
  if (manifest === undefined) throw unresolvedPackage(name, base);
  return loadJavaScript(url, entry, context, manifest);
}

function unresolvedPackage(name: string, base: string, cause?: unknown): Error {
  return new Error(base + ' could not resolve npm package ' + name + ' from Repometry at ' + installFrom.pathname, { cause });
}

async function loadJavaScript(url: string, entry: PluginReference, context: PluginContext, packageFile?: string) {
  let value: unknown;
  try {
    value = (await import(url)).default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(context.base + ' could not load its JavaScript plugin: ' + message, { cause: error });
  }
  return javaScriptManifest(value, entry, context, packageFile);
}

export async function javaScriptManifest(value: unknown, entry: PluginReference, context: PluginContext, packageFile?: string) {
  const { base, metadataOnly } = context;
  if (!isRecord(value) || typeof value.create !== 'function') {
    throw new Error(base + '/manifest/create must create the plugin operations');
  }
  const { create, ...metadata } = value;
  const manifest = checkManifest(metadata, base);
  const dockerField = dockerFields.find(key => Object.hasOwn(manifest, key));
  if (dockerField) throw new Error(base + '/manifest/' + dockerField + ' belongs in a Docker manifest');
  const options = validatePluginOptions(manifest.optionsSchema, entry.options, base);
  const unavailableReason = await unmetRequirement(readRequirements(manifest.requires, base + '/manifest/requires'));
  const version = packageFile === undefined ? manifest.version ?? '0.0.0' : await packageVersion(packageFile, base);
  const versionSource = packageFile === undefined ? (manifest.version === undefined ? 'default' : 'manifest') : 'package.json';
  const factory = !metadataOnly && unavailableReason === undefined
    ? await createPlugin(manifest, create as PluginManifest['create'], options, context)
    : { operations: [], produces: [] };
  const plugin = { ...manifestPlugin(manifest, version), ...factory,
    ...(options === undefined ? {} : { settings: options }), ...(unavailableReason === undefined ? {} : { unavailableReason }) };
  return { plugin, versionSource, requires: manifest.requires, ...manifestScope(manifest, base) };
}

async function createPlugin({ id, category }: Pick<PluginManifest, 'id' | 'category'>,
  create: PluginManifest['create'], options: PluginReference['options'], { root, base }: PluginContext) {
  const created = await create(structuredClone(options), { root });
  if (!isRecord(created) || !Array.isArray(created.operations) || !Array.isArray(created.produces)
    || Object.keys(created).some(key => !['operations', 'produces'].includes(key))
    || created.operations.some(operation => !isRecord(operation) || typeof operation.execute !== 'function')) {
    throw new Error(base + '/manifest/create must return executable operations and declared products');
  }
  const { operations, produces } = created;
  return { operations: operations.map(operation => authorOperation(id, category, operation)),
    produces: produces.map(({ valueSchema, ...product }) => valueSchema === undefined ? product : { ...product, schema: valueSchema }) };
}

async function packageVersion(path: string, base: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(manifest) || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(base + ' has no version in ' + path);
  }
  return manifest.version;
}
