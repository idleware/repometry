import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { pluginManifestSchema } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { PluginManifest, PluginCategory } from '@repometry/core/internal/engine/plugin-manifest.js';
import { findingCategory } from '@repometry/core/internal/engine/author-contracts.js';
import { isRecord, pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin, PluginKind } from '@repometry/core/internal/engine/plugin.js';
import schema from '@repometry/core/plugin-v1.schema.json' with { type: 'json' };
import { schemaError } from './schema-error.js';
import { pluginPatterns } from './plugin-reference.js';

export type Manifest = Omit<PluginManifest, 'create'> & {
  readonly image?: string;
  readonly command?: readonly string[];
  readonly scope?: 'file' | 'repository';
  readonly fileIndependent?: boolean;
  readonly limits?: Readonly<Partial<Record<'timeoutMs' | 'maxOutputBytes' | 'memoryBytes' | 'pidsLimit', number>>>;
  readonly tools?: Readonly<Record<string, string>>;
};

const categories: Record<PluginCategory, PluginKind> = {
  language: 'language', source: 'source', maintainability: 'analysis', coverage: 'coverage', security: 'security',
};
export const dockerFields = ['image', 'command', 'scope', 'fileIndependent', 'limits', 'tools'] as const;
let check: ValidateFunction<Manifest> | undefined;
const retiredFields = {
  api: 'schema', kinds: 'category', claims: 'include', settings: 'options',
  rules: 'checks', config: 'optionsSchema', providesLanguages: 'languages',
};

export function checkManifest(value: unknown, base: string): Manifest {
  const path = base + '/manifest';
  if (isRecord(value)) explainManifest(value, path);
  const validate = check ??= new Ajv2020().compile<Manifest>(schema);
  if (!validate(value)) throw schemaError(path, validate.errors?.[0]);
  distinctIds(value.languages, base + '/manifest/languages');
  distinctIds(value.checks, base + '/manifest/checks');
  for (const [index, language] of (value.languages ?? []).entries()) {
    pluginPatterns(language.include, base + '/manifest/languages/' + index + '/include');
  }
  return value;
}

function explainManifest(value: Record<string, unknown>, path: string): void {
  for (const [field, replacement] of Object.entries(retiredFields)) {
    if (Object.hasOwn(value, field)) throw new Error(path + '/' + field + ' is retired. Write ' + replacement + '.');
  }
  if (value.schema !== pluginManifestSchema) throw new Error(path + '/schema must be ' + pluginManifestSchema);
  if (typeof value.category !== 'string' || !Object.hasOwn(categories, value.category)) {
    throw new Error(path + '/category must be one of ' + Object.keys(categories).join(', '));
  }
}

function distinctIds(entries: readonly { id: string }[] | undefined, base: string): void {
  const ids = new Set<string>();
  for (const [index, { id }] of (entries ?? []).entries()) {
    if (ids.has(id)) throw new Error(base + '/' + index + '/id duplicates ' + id);
    ids.add(id);
  }
}

export function manifestScope({ include, exclude }: Manifest, base: string) {
  return { include: pluginPatterns(include, base + '/manifest/include'), exclude: pluginPatterns(exclude, base + '/manifest/exclude') };
}

export function manifestPlugin({ id, category, languages, optionsSchema, tools, checks }: Manifest, version: string):
  Omit<Plugin, 'operations' | 'produces' | 'settings'> {
  return { id, version, api: pluginApi, kinds: [categories[category]], config: optionsSchema, tools,
    ...(checks === undefined ? {} : { rules: checks.map(check => ({ ...check, category: findingCategory(category, check.defaults?.cost !== undefined) })) }),
    ...(languages === undefined ? {} : { providesLanguages: languages.map(({ include, measures, ...language }) => ({ ...language, globs: include,
      ...(measures === undefined ? {} : { measures: measures.map(measure => measure === 'checks' ? 'structuralRules' : measure) }) })) }) };
}
