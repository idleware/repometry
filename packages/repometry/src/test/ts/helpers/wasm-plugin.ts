import type { Plugin } from '@repometry/core/internal/engine/plugin.js';

// Load the packaged layout so the assets are resolved next to the runtime modules.
const moduleURL = new URL('../../../../main/ts/plugins/tree-sitter.js', import.meta.url);
export const { treeSitter } = await import(moduleURL.href) as { treeSitter: Plugin };
