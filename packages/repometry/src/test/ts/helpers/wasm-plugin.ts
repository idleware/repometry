import type { Plugin } from '../../../main/ts/core/engine/plugin.js';

// Load the packaged layout so the assets are resolved next to the runtime modules.
const moduleURL = new URL('../../../../main/ts/plugins/language-treesitter/tree-sitter.js', import.meta.url);
export const { treeSitter } = await import(moduleURL.href) as { treeSitter: Plugin };
