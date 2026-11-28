import { dirname, resolve } from 'node:path';
import { builtInPlugins } from './built-ins.js';
import { installedModule, javaScriptManifest, localModule } from './js-plugin.js';
import type { PluginContext } from './js-plugin.js';
import { validatePluginOptions } from './plugin-options.js';
import type { PluginReference } from './plugin-reference.js';
import { dockerPluginFile, dockerPluginImage } from './process-plugins.js';
import { registeredPlugin } from './registered-plugin.js';
import type { RegisteredPlugin } from './registered-plugin.js';
import type { ParserPlugin } from './parser-order.js';
import type { PluginManifest } from '@repometry/core/internal/engine/plugin-manifest.js';

export type PluginInput = string | PluginReference | PluginManifest;

const builtIns = new Map(builtInPlugins.map(plugin => [plugin.id, plugin]));

export async function loadPlugins(entries: readonly PluginInput[], root: string, configFile: string | undefined, metadataOnly = false) {
  const plugins: RegisteredPlugin[] = [];
  const configured = new Map<string, string>();
  const folder = configFile === undefined ? root : dirname(configFile);
  for (const [index, input] of entries.entries()) {
    const base = 'Config plugins/' + index;
    const entry = referenceOf(input);
    const { use, include, exclude } = entry;
    const { plugin, builtIn, versionSource, include: defaultInclude, exclude: defaultExclude, requires, image } =
      await resolvePlugin(input, entry, folder, { root, base, metadataOnly });
    const previous = configured.get(plugin.id) ?? (!builtIn && builtIns.has(plugin.id) ? plugin.id + ' (built-in)' : undefined);
    if (previous !== undefined) throw new Error(base + ' plugin ' + plugin.id + ' from ' + use + ' duplicates ' + previous);
    configured.set(plugin.id, use);
    plugins.push(registeredPlugin(plugin, { use, include: include ?? defaultInclude, exclude: exclude ?? defaultExclude,
      builtIn, versionSource, requires, image }));
  }
  return plugins;
}

function referenceOf(input: PluginInput): PluginReference {
  if (typeof input === 'string') return { use: input };
  return 'use' in input ? input : { use: 'manifest:' + input.id };
}

type ResolvedPlugin = Pick<PluginReference, 'include' | 'exclude'> & {
  readonly plugin: ParserPlugin;
  readonly builtIn: boolean;
  readonly versionSource: string;
  readonly requires?: PluginManifest['requires'];
  readonly image?: string;
};

async function resolvePlugin(input: PluginInput, entry: PluginReference, folder: string, context: PluginContext): Promise<ResolvedPlugin> {
  const { use } = entry;
  const { base } = context;
  if (typeof input === 'object' && !('use' in input)) {
    return { ...await javaScriptManifest(input, entry, context), builtIn: false };
  }
  if (use.startsWith('docker:')) return { ...await dockerPluginImage(use.slice(7), entry, base), builtIn: false };
  if (use.startsWith('./') || use.startsWith('../') || use.startsWith('/')) {
    const path = resolve(folder, use);
    if (path.endsWith('.json')) return { ...await dockerPluginFile(path, entry, base), builtIn: false };
    return { ...await localModule(path, entry, context), builtIn: false };
  }
  const builtIn = builtIns.get(use);
  if (builtIn !== undefined) {
    validatePluginOptions(builtIn.config, entry.options, base);
    return { plugin: builtIn, versionSource: 'built-in', builtIn: true, include: undefined, exclude: undefined, requires: undefined };
  }
  return { ...await installedModule(use.startsWith('npm:') ? use.slice(4) : use, entry, context), builtIn: false };
}
