import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { isJsonValue } from '@repometry/core/internal/model/plugin-data.js';
import type { JsonValue } from '@repometry/core/internal/model/plugin-data.js';
import { normalizeExclusions } from '@repometry/core/internal/profile/exclusions.js';

export interface PluginReference {
  readonly use: string;
  readonly options?: JsonValue;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export function readPluginReferences(value: unknown): readonly PluginReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Config plugins must be an array');
  return value.map(readReference);
}

function readReference(value: unknown, index: number): PluginReference {
  const base = 'Config plugins/' + index;
  if (typeof value === 'string') return { use: reference(value, base) };
  if (isRecord(value) && ['id', 'image', 'command'].some(key => Object.hasOwn(value, key))) {
    throw new Error(base + ' describes a plugin inline. Move it into a manifest file and reference it with { "use": "./plugin.json" }.');
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'use')
    || Object.keys(value).some(key => !['use', 'options', 'include', 'exclude'].includes(key))) {
    throw new Error(base + ' must be a reference string or an object with use, options, include and exclude');
  }
  const { use, options, include, exclude } = value;
  if (options !== undefined && !isJsonValue(options)) throw new Error(base + '/options must be JSON data');
  const included = pluginPatterns(include, base + '/include');
  const excluded = pluginPatterns(exclude, base + '/exclude');
  return { use: reference(use, base + '/use'), ...(options === undefined ? {} : { options }),
    ...(included === undefined ? {} : { include: included }), ...(excluded === undefined ? {} : { exclude: excluded }) };
}

function reference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes("\0")) throw new Error(field + ' must be a nonempty plugin reference');
  return value;
}

export function pluginPatterns(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return normalizeExclusions(value, field);
}
