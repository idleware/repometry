import type { Plugin } from '../core/engine/plugin.js';
import { coverage } from '../plugins/coverage/coverage.js';
import { diffCoverage } from '../plugins/coverage/diff-coverage.js';
import { duplication } from '../plugins/duplication/duplication.js';
import { maintainability } from '../plugins/maintainability/maintainability.js';
import { structure } from '../plugins/structure/structure.js';
import { nativeLanguageIds } from './native-language-plugins.js';
import type { NativeLanguagePlugin } from './native-language-plugins.js';
import { defaultLanguages, languageRegistry } from './languages.js';
import { sourceProviders } from './sources.js';
import { securityPlugins } from './security-plugins.js';

const builtInPlugins = [...defaultLanguages.providers.map(({ plugin }) => plugin), structure, maintainability, duplication, coverage,
  diffCoverage, ...securityPlugins, ...sourceProviders];

export const builtInPluginIds = new Set([...builtInPlugins.map(({ id }) => id), ...nativeLanguageIds]);

export function effectivePlugins(additional: readonly Plugin[]) {
  const native = languageRegistry(additional).native.map(plugin => ({ ...describePlugin(plugin), ...(plugin.tools ? { tools: plugin.tools } : {}) }));
  return [...builtInPlugins.map(describePlugin), ...native, ...additional.map(describePlugin)];
}

function describePlugin({ id, version, kinds, claims, providesLanguages, unavailableReason }: NativeLanguagePlugin) {
  return { id, version, kinds, ...(claims ? { claims } : {}), ...(providesLanguages ? { providesLanguages } : {}),
    ...(unavailableReason ? { unavailableReason } : {}) };
}
