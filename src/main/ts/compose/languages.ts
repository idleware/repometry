import { extname } from 'node:path';
import type { FileClaims, Operation, Plugin } from '../core/engine/plugin.js';
import { fileTypeId } from '../core/model/file-types.js';
import { codeStructure, codeStructures } from '../core/model/code-structure.js';
import type { LanguageDisplay } from '../core/model/language.js';
import { isExcludedDirectory } from '../core/model/snapshot.js';
import { exclusionMatcher } from '../core/profile/exclusions.js';
import { restrictStructureMeasures } from './structure-measures.js';
import { babelProvider } from '../plugins/language-js/babel-provider.js';

export interface LanguageProvider {
  readonly plugin: Plugin;
  readonly operation: Operation;
  readonly key: string;
  readonly batch: boolean;
  readonly language: (path: string) => string | undefined;
}

export const defaultLanguages = languageRegistry([]);

export function languageRegistry(plugins: readonly Plugin[]): {
  select(path: string): LanguageProvider | undefined;
  isSource(path: string): boolean;
  id(path: string): string;
  readonly extensions: readonly string[];
  readonly globs: readonly string[];
  readonly catalog: readonly LanguageDisplay[];
  readonly providers: readonly LanguageProvider[];
} {
  const entries = [babelProvider, ...plugins.filter(plugin => plugin.kinds?.includes('language'))].map(plugin => {
    const operations = plugin.operations.filter(operation => operation.role === 'provider'
      && operation.output.id === (operation.scope === 'repository' ? codeStructures.id : codeStructure.id));
    const [operation] = operations;
    const declared = plugin.providesLanguages ?? [];
    if (!operation || operations.length !== 1 || (!plugin.claims && !declared.length)) {
      throw new Error(`Language plugin ${plugin.id} must claim files and provide code structure`);
    }
    const classifiers = declared.map(({ id, extensions, globs }) => ({ id, matches: claimMatcher({ extensions, globs }) }));
    function language(path: string): string | undefined {
      let found: string | undefined;
      for (const { id, matches } of classifiers) {
        if (!matches(path)) continue;
        if (found) throw new Error(`Language plugin ${plugin.id} declares multiple languages for ${path}`);
        found = id;
      }
      return found;
    }
    const bound = restrictStructureMeasures(operation, declared, language);
    const executable = bound === operation ? plugin : { ...plugin, operations: plugin.operations.map(item => item === operation ? bound : item) };
    const provider = { plugin: executable, operation: bound, key: `${plugin.id}/${operation.id}`, batch: operation.scope === 'repository', language };
    const claims: readonly FileClaims[] = declared.length ? declared : [plugin.claims!];
    return { provider, claims, matches: declared.length ? (path: string) => language(path) !== undefined : claimMatcher(plugin.claims) };
  });
  const claims = entries.flatMap(entry => entry.claims);
  const extensions = [...new Set(claims.flatMap(entry => entry.extensions ?? []))];
  const globs = [...new Set(claims.flatMap(entry => entry.globs ?? []))];
  const providers = entries.map(({ provider }) => provider);
  const catalog = providers.flatMap(({ plugin }) => (plugin.providesLanguages ?? []).map(({ id, label, color }) => ({
    id, label, ...(color === undefined ? {} : { color }),
  })));
  if (new Set(catalog.map(({ id }) => id)).size !== catalog.length) throw new Error('Duplicate provided language ID');
  return { select, isSource: path => select(path) !== undefined, id: path => select(path)?.language(path) ?? fileTypeId(path), extensions, globs,
    catalog, providers };

  function select(path: string): LanguageProvider | undefined {
    let selected: LanguageProvider | undefined;
    for (const { provider, matches } of entries) {
      if (!matches(path)) continue;
      if (!selected && path.split('/').slice(0, -1).some(isExcludedDirectory)) return undefined;
      if (selected) throw new Error(`Multiple language providers claim ${path}: ${selected.plugin.id}, ${provider.plugin.id}`);
      selected = provider;
    }
    return selected;
  }
}

export function claimMatcher(claims: FileClaims | undefined, identify = fileTypeId): (path: string) => boolean {
  const { extensions = [], globs = [], languages = [] } = claims ?? {};
  if (extensions.length === 0 && globs.length === 0 && languages.length === 0) return () => true;
  const glob = exclusionMatcher(globs);
  const suffixes = new Set(extensions);
  const languageSet = new Set(languages);
  return path => suffixes.has(extname(path)) || glob(path) || (languageSet.size > 0 && languageSet.has(identify(path)));
}
