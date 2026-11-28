import { posix } from 'node:path';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { fileTypes } from '@repometry/core/internal/model/file-types.js';
import catalog from '../../resources/language-catalog.json' with { type: 'json' };
import { registeredPlugins } from './built-ins.js';
import { languageFileSelection } from './file-selection.js';

const fileTypesByExtension = new Map(fileTypes.flatMap(type =>
  (type.extensions ?? []).map(extension => [extension, type.id] as const)));
const officialByExtension = new Map<string, string>();
const packagesByLanguage = new Map<string, Set<string>>();
const experimentalPackages = new Set(catalog.filter(entry => entry.experimental).map(entry => entry.package));
const labels = new Map(catalog.map(({ language, label }) => [language, label]));
for (const entry of catalog) {
  const packages = packagesByLanguage.get(entry.language) ?? new Set<string>();
  packages.add(entry.package);
  packagesByLanguage.set(entry.language, packages);
  for (const extension of entry.extensions) {
    if (fileTypesByExtension.get(extension) === entry.language) officialByExtension.set(extension, entry.language);
  }
}

export interface MissingLanguagePlugin {
  readonly language: string;
  readonly files: number;
  readonly packages: readonly string[];
}

export function detectMissingLanguages(plugins: readonly Plugin[]) {
  const providers = registeredPlugins(plugins).filter(plugin => plugin.kinds.includes('language'));
  const configured = new Set(providers.flatMap(plugin => plugin.providesLanguages?.map(({ id }) => id) ?? []));
  const matchers = providers.filter(plugin => plugin.providesLanguages?.length || plugin.claims).map(plugin => languageFileSelection(plugin, plugin.providesLanguages ?? []).matches);
  const counts = new Map<string, number>();

  function candidateLanguage(path: string) {
    const language = officialByExtension.get(posix.extname(path));
    return language === undefined || configured.has(language) ? undefined : language;
  }

  return {
    candidate: (path: string) => candidateLanguage(path) !== undefined,
    record(path: string) {
      const language = candidateLanguage(path);
      if (language === undefined || matchers.some(matches => matches(path))) return;
      counts.set(language, (counts.get(language) ?? 0) + 1);
    },
    results(): readonly MissingLanguagePlugin[] {
      return [...packagesByLanguage].flatMap(([language, packages]) => {
        const files = counts.get(language);
        return files === undefined ? [] : [{ language, files, packages: [...packages] }];
      });
    },
  };
}

export function missingLanguageNotice({ language, files, packages }: MissingLanguagePlugin): string {
  const label = labels.get(language) ?? language;
  const choices = packages.map(name => experimentalPackages.has(name) ? name + ' (experimental)' : name).join(' or ');
  const install = packages.map(name => 'npm install -D ' + name).join(' or ');
  const noun = files === 1 ? 'file has' : 'files have';
  return `${label}: ${files} ${noun} no configured parser. Install ${choices} next to Repometry (${install}) and add it to plugins in repometry.config.json.`;
}
