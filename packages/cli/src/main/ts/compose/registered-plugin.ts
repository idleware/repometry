import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { PluginManifest } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { PluginReference } from './plugin-reference.js';
import type { ParserPlugin } from './parser-order.js';

const registration = Symbol('repometry.configured-plugin');

type Registration = Omit<PluginReference, 'options'> & {
  readonly builtIn: boolean;
  readonly versionSource: string;
  readonly image?: string;
  readonly requires?: PluginManifest['requires'];
};

export type RegisteredPlugin = ParserPlugin & { readonly [registration]: Registration };

export function registeredPlugin(plugin: ParserPlugin, metadata: Registration): RegisteredPlugin {
  return { ...plugin, [registration]: metadata };
}

export function pluginRegistration(plugin: Plugin): Registration | undefined {
  return (plugin as Partial<RegisteredPlugin>)[registration];
}
