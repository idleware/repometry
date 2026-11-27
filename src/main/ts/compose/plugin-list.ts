import type { Plugin } from '../core/engine/plugin.js';
import type { NativeLanguagePlugin } from './native-language-plugins.js';
import { languageRegistry } from './languages.js';
import { builtInPlugins } from './built-ins.js';
import type { ParserOrder } from './parser-order.js';

export function effectivePlugins(additional: readonly Plugin[], parsers?: ParserOrder) {
  const { native, describe } = languageRegistry(additional, true, parsers);
  const host = native.map(plugin => ({ ...describePlugin(describe(plugin)), ...(plugin.tools ? { tools: plugin.tools } : {}) }));
  return [...builtInPlugins.map(plugin => describePlugin(describe(plugin))), ...host, ...additional.map(plugin => describePlugin(describe(plugin)))];
}

function describePlugin({ id, version, kinds, claims, providesLanguages, unavailableReason }: NativeLanguagePlugin) {
  return { id, version, kinds, ...(claims ? { claims } : {}),
    ...(providesLanguages ? { providesLanguages: providesLanguages.map(({ syntax, ...language }) => language) } : {}),
    ...(unavailableReason ? { unavailableReason } : {}) };
}
