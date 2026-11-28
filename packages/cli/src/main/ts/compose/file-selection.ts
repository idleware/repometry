import { extname } from 'node:path';
import type { FileClaims, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { fileTypeId } from '@repometry/core/internal/model/file-types.js';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';
import { exclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import { pluginScope, scopedMatcher } from './plugin-scope.js';

export function languageFileSelection(plugin: Plugin, declared: readonly ProvidedLanguage[]) {
  const classifiers = declared.map(language => ({ id: language.id, matches: claimMatcher(parserClaims(plugin, language)) }));
  function classify(path: string): string | undefined {
    const [first, second] = classifiers.filter(({ matches }) => matches(path));
    if (second) throw new Error(`Language plugin ${plugin.id} declares multiple languages for ${path}`);
    return first?.id;
  }
  const included = pluginScope(plugin)?.include;
  const fallback = included !== undefined && declared.length === 1 ? declared[0]!.id : undefined;
  const identify = (path: string) => classify(path) ?? fallback;
  const defaultMatches = declared.length ? (path: string) => classify(path) !== undefined : claimMatcher(plugin.claims);
  const eligible = scopedMatcher(plugin, defaultMatches);
  const matches = declared.length ? (path: string) => eligible(path) && identify(path) !== undefined : eligible;
  const originalClaims: readonly FileClaims[] = declared.length ? declared : [plugin.claims!];
  const claims = included === undefined ? originalClaims : [...originalClaims, { globs: included }];
  return { claims, matches, identify };
}

function parserClaims(plugin: Plugin, { extensions = [], globs }: ProvidedLanguage): FileClaims {
  // Official native packages serialize simple suffix selectors as patterns. Match them as suffixes, like bundled parsers.
  const nativeExtensions = plugin.languageProvenanceRequiresSource
    ? (globs ?? []).flatMap(pattern => /^\*\*\/\*(\.[A-Za-z0-9_-]+)$/.exec(pattern)?.[1] ?? []) : [];
  return { extensions: [...extensions, ...nativeExtensions], globs };
}

export function claimMatcher(claims: FileClaims | undefined, identify = fileTypeId): (path: string) => boolean {
  const { extensions = [], globs = [], languages = [] } = claims ?? {};
  if (extensions.length === 0 && globs.length === 0 && languages.length === 0) return () => true;
  const glob = exclusionMatcher(globs);
  const suffixes = new Set(extensions);
  const languageSet = new Set(languages);
  return path => suffixes.has(extname(path)) || glob(path) || (languageSet.size > 0 && languageSet.has(identify(path)));
}
