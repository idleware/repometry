import { findPackageJSON } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { Distribution } from '../../../main/ts/compose/distribution.js';
import { languageRegistry } from '../../../main/ts/compose/languages.js';

const manifest = findPackageJSON('repometry', import.meta.url);
if (manifest === undefined) throw new Error('No default Repometry distribution in the test workspace');
const target = new URL('./target/main/ts/', pathToFileURL(manifest));
export const defaultCli = fileURLToPath(new URL('cli/main.js', target));
export const { default: defaultDistribution } = await import(new URL('distribution.js', target).href) as { default: Distribution };
export const languagePlugins = defaultDistribution.bundled;
export const bundledLanguages = languageRegistry(languagePlugins, defaultDistribution.parsers);

export function wasmParser(path: string): Plugin {
  const extension = extname(path);
  const plugin = languagePlugins.find(entry =>
    entry.providesLanguages?.some(language => language.extensions?.includes(extension)));
  if (!plugin) throw new Error('No WASM parser for ' + path);
  return plugin;
}
