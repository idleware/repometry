import type { MetricDescriptor, PluginConfigSchema, RuleDescriptor } from '../engine/plugin.js';
import type { InventoryFile } from './source.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 512) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.values(value).every(item => isJsonValue(item, depth + 1));
}

export interface PersistedProduct {
  readonly operation: string;
  readonly path?: string;
  readonly value: JsonValue;
}

export interface PluginData {
  readonly metrics: readonly MetricDescriptor[];
  readonly measured: readonly string[];
  readonly privateMetrics?: readonly string[];
  readonly rules: readonly { readonly plugin: string; readonly rules: readonly RuleDescriptor[] }[];
  readonly products: Readonly<Record<string, readonly PersistedProduct[]>>;
  readonly contracts?: Readonly<Record<string, PluginConfigSchema>>;
  readonly inventory?: readonly (InventoryFile & { readonly language: string; readonly analysed: boolean })[];
}
