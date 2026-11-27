import { extname } from 'node:path';
import { plan } from '../core/engine/plan.js';
import type { FileClaims, Operation, Plugin } from '../core/engine/plugin.js';
import { fileTypeId } from '../core/model/file-types.js';
import { codeStructure, codeStructures } from '../core/model/code-structure.js';
import type { ProvidedLanguage } from '../core/model/language.js';
import { isExcludedDirectory } from '../core/model/snapshot.js';
import { exclusionMatcher } from '../core/profile/exclusions.js';
import { nativeLanguagePlugins } from './native-language-plugins.js';
import type { NativeLanguagePlugin } from './native-language-plugins.js';
import { describeProvider, selectedSyntax, selectParsers } from './parser-order.js';
import type { ParserOrder } from './parser-order.js';
import { restrictStructureMeasures } from './structure-measures.js';
import { builtInPluginIds, builtInPlugins } from './built-ins.js';

export interface LanguageProvider {
  readonly plugin: Plugin;
  readonly operation: Operation;
  readonly key: string;
  readonly batch: boolean;
  readonly language: (path: string) => string | undefined;
}

export const defaultLanguages = languageRegistry([], false);
export type LanguageRegistry = ReturnType<typeof languageRegistry>;

export function languageRegistry(plugins: readonly Plugin[], includeNative = true, parsers?: ParserOrder, label = 'parsers') {
  const native = includeNative ? nativeLanguagePlugins() : [];
  const builtIns = builtInPlugins.filter(plugin => !plugins.includes(plugin));
  const registered: readonly NativeLanguagePlugin[] = [...builtIns, ...plugins, ...native];
  if (plugins.length) validateRegistrations(plugins, registered);
  const { selection, competing } = selectParsers(registered, parsers, label);
  const byProvider = new Map<string, ProvidedLanguage[]>();
  for (const { plugin, language } of selection.values()) byProvider.set(plugin.id, [...byProvider.get(plugin.id) ?? [], language]);
  const bindings = new Map<Plugin, Plugin>();
  const entries = registered.filter(plugin => plugin.kinds.includes('language')).flatMap(plugin =>
    languageEntry(plugin, byProvider.get(plugin.id) ?? [], bindings));
  const active = entries.flatMap(({ provider }) => provider ?? []);
  const claims = [...entries.filter(entry => entry.provider), ...entries.filter(entry => !entry.provider)].flatMap(entry => entry.claims);
  const extensions = [...new Set(claims.flatMap(entry => entry.extensions ?? []))];
  const globs = [...new Set(claims.flatMap(entry => entry.globs ?? []))];
  const catalog = entries.filter(({ provider }) => provider).flatMap(({ declared }) =>
    declared.map(({ id, label, color }) => ({ id, label, ...(color === undefined ? {} : { color }) })));
  const syntaxById = selectedSyntax(selection, competing);
  const unavailable = native.filter(({ unavailableReason }) => unavailableReason !== undefined);
  const ordered = [...builtIns, ...native.filter(plugin => !unavailable.includes(plugin)), ...plugins, ...unavailable];
  const bound: readonly NativeLanguagePlugin[] = ordered.map(plugin => bindings.get(plugin) ?? plugin);
  return { select: (path: string) => match(path)?.provider, isSource: (path: string) => match(path) !== undefined,
    id: (path: string) => match(path)?.identify(path) ?? fileTypeId(path), extensions, globs, catalog,
    providers: active, native, plugins: bound,
    describe: (plugin: NativeLanguagePlugin) => describeProvider(plugin, byProvider, competing),
    syntax: (id: string) => syntaxById.get(id), skipped };

  function skipped(path: string): boolean {
    const entry = match(path);
    return entry !== undefined && entry.provider === undefined;
  }

  function match(path: string) {
    let matched: (typeof entries)[number] | undefined;
    for (const entry of entries) {
      if (!entry.matches(path)) continue;
      if (matched) throw new Error('Multiple language providers claim ' + path + ': ' + matched.id + ', ' + entry.id);
      if (path.split('/').slice(0, -1).some(isExcludedDirectory)) return undefined;
      matched = entry;
    }
    return matched;
  }
}

function validateRegistrations(plugins: readonly Plugin[], registered: readonly Plugin[]): void {
  if (plugins.some(plugin => builtInPluginIds.has(plugin.id) && !builtInPlugins.includes(plugin))) {
    throw new Error('An additional plugin uses a built-in plugin ID');
  }
  plan({ plugins: registered, select: [], inputs: new Map() });
}

function languageEntry(plugin: NativeLanguagePlugin, chosen: readonly ProvidedLanguage[], bindings: Map<Plugin, Plugin>) {
  const declared = (plugin.providesLanguages ?? []).filter(language => chosen.includes(language));
  const selected = !plugin.providesLanguages || declared.length > 0;
  const available = plugin.unavailableReason === undefined;
  const operation = available || plugin.operations.length ? parserOperation(plugin) : undefined;
  if (operation && (!selected || !available)) {
    bindings.set(plugin, { ...plugin, operations: plugin.operations.filter(item => item !== operation) });
  }
  if (!selected) return [];
  const classifiers = declared.map(({ id, extensions, globs }) => ({ id, matches: claimMatcher({ extensions, globs }) }));
  function identify(path: string): string | undefined {
    const [first, second] = classifiers.filter(({ matches }) => matches(path));
    if (second) throw new Error(`Language plugin ${plugin.id} declares multiple languages for ${path}`);
    return first?.id;
  }
  const provider = available && operation ? bindParser(plugin, operation, declared, identify) : undefined;
  if (provider) bindings.set(plugin, provider.plugin);
  const claims: readonly FileClaims[] = declared.length ? declared : [plugin.claims!];
  const matches = declared.length ? (path: string) => identify(path) !== undefined : claimMatcher(plugin.claims);
  return [{ id: plugin.id, provider, declared, claims, matches, identify }];
}

function parserOperation(plugin: Plugin): Operation {
  const operations = plugin.operations.filter(operation => operation.role === 'provider'
    && operation.output.id === (operation.scope === 'repository' ? codeStructures.id : codeStructure.id));
  const [operation] = operations;
  if (!operation || operations.length !== 1 || (!plugin.claims && !plugin.providesLanguages?.length)) {
    throw new Error(`Language plugin ${plugin.id} must claim files and provide code structure`);
  }
  return operation;
}

function bindParser(plugin: Plugin, operation: Operation, declared: readonly ProvidedLanguage[],
  language: LanguageProvider['language']): LanguageProvider {
  const bound = restrictStructureMeasures(operation, declared, language);
  const executable = bound === operation ? plugin : { ...plugin, operations: plugin.operations.map(item => item === operation ? bound : item) };
  return { plugin: executable, operation: bound, key: `${plugin.id}/${operation.id}`, batch: operation.scope === 'repository', language };
}

export function claimMatcher(claims: FileClaims | undefined, identify = fileTypeId): (path: string) => boolean {
  const { extensions = [], globs = [], languages = [] } = claims ?? {};
  if (extensions.length === 0 && globs.length === 0 && languages.length === 0) return () => true;
  const glob = exclusionMatcher(globs);
  const suffixes = new Set(extensions);
  const languageSet = new Set(languages);
  return path => suffixes.has(extname(path)) || glob(path) || (languageSet.size > 0 && languageSet.has(identify(path)));
}
