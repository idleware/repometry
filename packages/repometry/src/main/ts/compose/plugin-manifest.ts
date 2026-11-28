import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { pluginManifestSchema } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { PluginManifest } from '@repometry/core/internal/engine/plugin-manifest.js';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { category } from '@repometry/core/internal/model/inspection-category.js';
import schema from '@repometry/core/plugin-v1.schema.json' with { type: 'json' };
import { schemaError } from './schema-error.js';
import { pluginPatterns } from './plugin-reference.js';

export type Manifest = Omit<PluginManifest, 'create'> & {
  readonly image?: string;
  readonly command?: readonly string[];
  readonly scope?: 'file' | 'repository';
  readonly fileIndependent?: boolean;
  readonly limits?: Readonly<Partial<Record<'timeoutMs' | 'maxOutputBytes' | 'memoryBytes' | 'pidsLimit', number>>>;
};

export const dockerFields = ['image', 'command', 'scope', 'fileIndependent', 'limits'] as const;
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
  if (typeof value.category !== 'string' || !Object.hasOwn(category, value.category)) {
    throw new Error(path + '/category must be one of ' + Object.keys(category).join(', '));
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
