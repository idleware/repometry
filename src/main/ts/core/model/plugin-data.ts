import type { MetricDescriptor, PluginConfigSchema, RuleDescriptor } from '../engine/plugin.js';
import type { InventoryFile } from './source.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

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
