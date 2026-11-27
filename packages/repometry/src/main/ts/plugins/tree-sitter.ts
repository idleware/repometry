import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { go } from '@repometry/language-go';
import { python } from '@repometry/language-python';
import { treeSitter as treeSitterPlugin } from '@repometry/tree-sitter';

const units = [go, python];

/** The built-in tree-sitter plugin with the bundled languages. */
export const treeSitter = treeSitterPlugin(units);

/** The grammar packages a plugin's inspection used, for the languages the repository contains. */
export function usedGrammarTools(plugin: Plugin, languages: ReadonlySet<string>) {
  return Object.fromEntries(units.filter(({ language }) => languages.has(language.id))
    .map(({ tool }) => [tool.package, plugin.tools?.[tool.package] ?? tool.version]));
}
