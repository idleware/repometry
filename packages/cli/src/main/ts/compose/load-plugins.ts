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
import { slimDistribution } from './distribution.js';
import type { Distribution } from './distribution.js';

export type PluginInput = string | PluginReference | PluginManifest;

export async function loadPlugins(entries: readonly PluginInput[], root: string, configFile: string | undefined, metadataOnly = false,
  distribution: Distribution = slimDistribution) {
  const plugins: RegisteredPlugin[] = [];
  const configured = new Map<string, string>();
  const builtIns = new Map([...builtInPlugins, ...distribution.bundled].map(plugin => [plugin.id, plugin]));
  const folder = configFile === undefined ? root : dirname(configFile);
  for (const [index, input] of entries.entries()) {
    const base = 'Config plugins/' + index;
    const entry = referenceOf(input);
    const { use, include, exclude } = entry;
    const { plugin, builtIn, versionSource, include: defaultInclude, exclude: defaultExclude, requires, image } =
      await resolvePlugin(input, entry, folder, { root, base, metadataOnly, distribution }, builtIns);
    const previous = configured.get(plugin.id) ?? (!builtIn && builtIns.has(plugin.id) ? plugin.id + ' (built-in)' : undefined);
    if (previous !== undefined) throw new Error(base + ' plugin ' + plugin.id + ' from ' + use + ' duplicates ' + previous);
    configured.set(plugin.id, use);
    plugins.push(registeredPlugin(plugin, { use, include: include ?? defaultInclude, exclude: exclude ?? defaultExclude,
      builtIn, versionSource, requires, image }));
  }
  return withBundled(distribution, plugins);
}

function withBundled({ bundled }: Distribution, plugins: readonly RegisteredPlugin[]): RegisteredPlugin[] {
  if (bundled.length === 0) return [...plugins];
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]));
  const defaults = bundled.map(plugin => {
    const configured = byId.get(plugin.id);
    byId.delete(plugin.id);
    return configured ?? registeredPlugin(plugin, { use: plugin.id, builtIn: true, versionSource: 'built-in' });
  });
  return [...defaults, ...byId.values()];
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

async function resolvePlugin(input: PluginInput, entry: PluginReference, folder: string, context: PluginContext,
  builtIns: ReadonlyMap<string, ParserPlugin>): Promise<ResolvedPlugin> {
  const { use } = entry;
  const { base } = context;
  if (typeof input === 'object' && !('use' in input)) {
    return { ...await javaScriptManifest(input, entry, context), builtIn: false };
  }
  if (use.startsWith('docker:')) {
    return { ...await dockerPluginImage(use.slice(7), entry, { base, packageUrl: context.distribution?.packageUrl }), builtIn: false };
  }
  if (use.startsWith('./') || use.startsWith('../') || use.startsWith('/')) {
    const path = resolve(folder, use);
    if (path.endsWith('.json')) {
      return { ...await dockerPluginFile(path, entry, { base, packageUrl: context.distribution?.packageUrl }), builtIn: false };
    }
    return { ...await localModule(path, entry, context), builtIn: false };
  }
  const pkg = use.startsWith('npm:') ? use.slice(4) : use;
  const alias = pkg.startsWith('@repometry/language-') ? builtIns.get(pkg.slice('@repometry/'.length)) : undefined;
  const builtIn = builtIns.get(use) ?? alias;
  if (builtIn !== undefined) {
    validatePluginOptions(builtIn.config, entry.options, base);
    return { plugin: builtIn, versionSource: 'built-in', builtIn: true, include: undefined, exclude: undefined, requires: undefined };
  }
  const installed = await installedModule(pkg, entry, context);
  const plugin = pkg.startsWith('@repometry/language-') && pkg === '@repometry/' + installed.plugin.id
    ? { ...installed.plugin, languageProvenanceRequiresSource: true as const } : installed.plugin;
  return { ...installed, plugin, builtIn: false };
}
