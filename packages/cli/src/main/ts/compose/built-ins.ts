import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { pluginRegistration } from './registered-plugin.js';
import { builtInPlugins } from '../plugins/built-in.js';

// The one edge from compose to plugins: everything else in compose reads the built-ins from here.
export { builtInPlugins };

export const builtInPluginIds: ReadonlySet<string> = new Set(builtInPlugins.map(({ id }) => id));

/** Configured built-ins replace their defaults in registration order. */
export function registeredPlugins(additional: readonly Plugin[]): readonly Plugin[] {
  const overrides = new Map(additional.filter(plugin => pluginRegistration(plugin)?.builtIn).map(plugin => [plugin.id, plugin]));
  const builtIns = builtInPlugins.filter(plugin => !additional.includes(plugin)).map(plugin => overrides.get(plugin.id) ?? plugin);
  return [...builtIns, ...additional.filter(plugin => !pluginRegistration(plugin)?.builtIn || !builtInPluginIds.has(plugin.id))];
}
