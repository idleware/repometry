import type { Plugin } from '../core/engine/plugin.js';
import type { NativeLanguagePlugin } from './native-language-plugins.js';
import { languageRegistry } from './languages.js';
import { builtInPlugins } from './built-ins.js';

export function effectivePlugins(additional: readonly Plugin[]) {
  const native = languageRegistry(additional).native.map(plugin => ({ ...describePlugin(plugin), ...(plugin.tools ? { tools: plugin.tools } : {}) }));
  return [...builtInPlugins.map(describePlugin), ...native, ...additional.map(describePlugin)];
}

function describePlugin({ id, version, kinds, claims, providesLanguages, unavailableReason }: NativeLanguagePlugin) {
  return { id, version, kinds, ...(claims ? { claims } : {}),
    ...(providesLanguages ? { providesLanguages: providesLanguages.map(({ syntax, ...language }) => language) } : {}),
    ...(unavailableReason ? { unavailableReason } : {}) };
}
