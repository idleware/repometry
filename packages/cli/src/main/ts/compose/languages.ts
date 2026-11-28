import { extname } from 'node:path';
import { plan } from '@repometry/core/internal/engine/plan.js';
import type { Operation, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { fileTypeId, fileTypes } from '@repometry/core/internal/model/file-types.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';
import { isExcludedDirectory } from '@repometry/core/internal/model/snapshot.js';
import { describeProvider, selectedSyntax, selectParsers } from './parser-order.js';
import type { ParserOrder, ParserPlugin } from './parser-order.js';
import { languageMeasures, restrictStructureMeasures, structureImplementation } from './structure-measures.js';
import { builtInPluginIds, builtInPlugins, registeredPlugins } from './built-ins.js';
import { pluginRegistration } from './registered-plugin.js';
import { languageFileSelection } from './file-selection.js';
import { pluginScope } from './plugin-scope.js';

export { claimMatcher } from './file-selection.js';

export interface LanguageProvider {
  readonly plugin: Plugin;
  readonly operation: Operation;
  readonly key: string;
  readonly batch: boolean;
  readonly language: (path: string) => string | undefined;
  readonly implementationFor: (present: ReadonlySet<string>) => string | undefined;
}

const fileTypeSyntax = new Map(fileTypes.flatMap(({ id, syntax }) => syntax === undefined ? [] : [[id, syntax] as const]));

export const defaultLanguages = languageRegistry([]);
export type LanguageRegistry = ReturnType<typeof languageRegistry>;

export function languageRegistry(plugins: readonly Plugin[], parsers?: ParserOrder, label = 'parsers') {
  const registered: readonly ParserPlugin[] = registeredPlugins(plugins);
  if (plugins.length) validateRegistrations(plugins, registered);
  const { selection, competing } = selectParsers(registered, parsers, label);
  const byProvider = new Map<string, ProvidedLanguage[]>();
  for (const { plugin, language } of selection.values()) byProvider.set(plugin.id, [...byProvider.get(plugin.id) ?? [], language]);
  const bindings = new Map<Plugin, Plugin>();
  const entries = registered.filter(plugin => plugin.kinds.includes('language')).flatMap(plugin =>
    languageEntry(plugin, byProvider.get(plugin.id) ?? [], bindings));
  // The official C++ package accepts .h only through a configured include.
  const cpp = entries.find(entry => entry.id === 'language-cpp' && entry.requiresSource && entry.explicitInclude);
  const active = entries.flatMap(({ provider }) => provider ?? []);
  const { extensions, globs, catalog } = languageSelection(entries);
  const syntaxById = selectedSyntax(selection);
  const bound: readonly ParserPlugin[] = registered.map(plugin => bindings.get(plugin) ?? plugin);
  return { select: (path: string) => match(path)?.provider, isSource: (path: string) => match(path) !== undefined,
    id: (path: string) => match(path)?.identify(path) ?? fileTypeId(path), extensions, globs, catalog,
    providers: active, plugins: bound,
    reportSelection: (present: ReadonlySet<string>) => languageSelection(
      entries.filter(entry => !entry.requiresSource || present.has(entry.id))),
    describe: (plugin: ParserPlugin) => describeProvider(plugin, byProvider, competing),
    syntax: (id: string) => selection.has(id) ? syntaxById.get(id) : fileTypeSyntax.get(id), skipped };

  function skipped(path: string): boolean {
    const entry = match(path);
    return entry !== undefined && entry.provider === undefined;
  }

  function match(path: string) {
    let matched: (typeof entries)[number] | undefined;
    const cppHeader = cpp !== undefined && extname(path) === '.h' && cpp.matches(path);
    for (const entry of entries) {
      if (cppHeader && entry.id === 'language-c' && entry.requiresSource) continue;
      if (!entry.matches(path)) continue;
      if (matched) throw new Error(`Parsers ${matched.id} and ${entry.id} both include ${path}`);
      if (path.split('/').slice(0, -1).some(isExcludedDirectory)) return undefined;
      matched = entry;
    }
    return matched;
  }
}

function validateRegistrations(plugins: readonly Plugin[], registered: readonly Plugin[]): void {
  if (plugins.some(plugin => builtInPluginIds.has(plugin.id) && !builtInPlugins.includes(plugin) && !pluginRegistration(plugin)?.builtIn)) {
    throw new Error('An additional plugin uses a built-in plugin ID');
  }
  plan({ plugins: registered, select: [], inputs: new Map() });
}

function languageEntry(plugin: ParserPlugin, chosen: readonly ProvidedLanguage[], bindings: Map<Plugin, Plugin>) {
  const declared = (plugin.providesLanguages ?? []).filter(language => chosen.includes(language));
  const selected = !plugin.providesLanguages || declared.length > 0;
  const available = plugin.unavailableReason === undefined;
  const operation = available || plugin.operations.length ? parserOperation(plugin) : undefined;
  if (operation && (!selected || !available)) {
    bindings.set(plugin, { ...plugin, operations: plugin.operations.filter(item => item !== operation) });
  }
  if (!selected) return [];
  const { claims, matches, identify } = languageFileSelection(plugin, declared);
  const provider = available && operation ? bindParser(plugin, operation, declared, identify) : undefined;
  if (provider) bindings.set(plugin, provider.plugin);

  return [{ id: plugin.id, provider, declared, claims, matches, identify,
    requiresSource: plugin.languageProvenanceRequiresSource, explicitInclude: pluginScope(plugin)?.include !== undefined }];
}

function languageSelection(entries: ReadonlyArray<ReturnType<typeof languageEntry>[number]>) {
  const available = entries.filter(({ provider }) => provider !== undefined);
  const unavailable = entries.filter(({ provider }) => provider === undefined);
  const claims = [...available, ...unavailable].flatMap(entry => entry.claims);
  const extensions = [...new Set(claims.flatMap(entry => entry.extensions ?? []))];
  const globs = [...new Set(claims.flatMap(entry => entry.globs ?? []))];
  const catalog = available.flatMap(({ declared }) =>
    declared.map(({ id, label, color }) => ({ id, label, ...(color === undefined ? {} : { color }) })));
  return { extensions, globs, catalog };
}

function parserOperation(plugin: Plugin): Operation {
  const operations = plugin.operations.filter(operation => operation.role === 'provider'
    && operation.output.id === (operation.scope === 'repository' ? codeStructures.id : codeStructure.id));
  const [operation] = operations;
  if (!operation || operations.length !== 1 || (!plugin.claims && !plugin.providesLanguages?.length)) {
    throw new Error(`Language plugin ${plugin.id} must declare languages with include patterns and provide exactly one code structure operation`);
  }
  return operation;
}

function bindParser(plugin: Plugin, operation: Operation, declared: readonly ProvidedLanguage[],
  language: LanguageProvider['language']): LanguageProvider {
  const measured = languageMeasures(declared);
  const bound = restrictStructureMeasures(operation, measured, language);
  const executable = bound === operation ? plugin : { ...plugin, operations: plugin.operations.map(item => item === operation ? bound : item) };
  return { plugin: executable, operation: bound, key: `${plugin.id}/${operation.id}`, batch: operation.scope === 'repository', language,
    implementationFor: present => structureImplementation(operation, new Map([...measured].filter(([id]) => present.has(id)))) };
}
