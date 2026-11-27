import type { Plugin } from '../core/engine/plugin.js';
import { languageRegistry } from './languages.js';
import { builtInPlugins } from './built-ins.js';
import type { ParserOrder, ParserPlugin } from './parser-order.js';

export function effectivePlugins(additional: readonly Plugin[], parsers?: ParserOrder) {
  languageRegistry(additional, parsers);
  return [...builtInPlugins, ...additional].map(describePlugin);
}

function describePlugin({ id, version, kinds, claims, providesLanguages, unavailableReason }: ParserPlugin) {
  return { id, version, kinds, ...(claims ? { claims } : {}),
    ...(providesLanguages ? { providesLanguages: providesLanguages.map(({ syntax, ...language }) => language) } : {}),
    ...(unavailableReason ? { unavailableReason } : {}) };
}
