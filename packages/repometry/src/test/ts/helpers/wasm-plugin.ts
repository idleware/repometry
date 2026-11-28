import { extname } from 'node:path';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';

// Load the packaged layout so the assets are resolved next to the runtime modules.
const moduleURL = new URL('../../../../main/ts/plugins/tree-sitter.js', import.meta.url);
export const { languagePlugins } = await import(moduleURL.href) as { languagePlugins: readonly Plugin[] };

export function wasmParser(path: string): Plugin {
  const extension = extname(path);
  const plugin = languagePlugins.find(entry =>
    entry.providesLanguages?.some(language => language.extensions?.includes(extension)));
  if (!plugin) throw new Error('No WASM parser for ' + path);
  return plugin;
}
