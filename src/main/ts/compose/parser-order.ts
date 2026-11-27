import { isRecord } from '../core/engine/plugin.js';
import type { Plugin } from '../core/engine/plugin.js';
import type { LanguageSyntax, ProvidedLanguage } from '../core/model/language.js';

export interface ParserPlugin extends Plugin {
  readonly unavailableReason?: string;
}

export type ParserOrder = Readonly<Record<string, readonly string[]>>;

const languageId = /^[a-z][a-z0-9-]*$/;

type Candidate = { readonly plugin: ParserPlugin; readonly language: ProvidedLanguage };

export function readParserOrder(value: unknown, label = 'parsers'): ParserOrder | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(label + ' must map language IDs to lists of plugin IDs');
  for (const [id, names] of Object.entries(value)) {
    if (!languageId.test(id)) throw new Error(label + '/' + id + ' must use a language ID');
    if (!Array.isArray(names) || !names.length || !names.every(name => typeof name === 'string' && name.length > 0)
      || new Set(names).size !== names.length) {
      throw new Error(label + '/' + id + ' must be a nonempty list of unique plugin IDs');
    }
  }
  return value as ParserOrder;
}

export function selectParsers(plugins: readonly ParserPlugin[], order: ParserOrder | undefined, label: string) {
  const providers = languageCandidates(plugins);
  const known = new Set(plugins.map(({ id }) => id));
  const competing = new Set([...providers.values()].filter(candidates => candidates.length > 1).flatMap(
    candidates => candidates.map(({ plugin }) => plugin.id)));
  const selection = new Map<string, Candidate>();
  const configured = readParserOrder(order, label) ?? {};
  for (const id of Object.keys(configured).sort()) {
    const options = providers.get(id);
    if (!options) throw new Error(label + '/' + id + ' names an unknown language');
    const candidates = configured[id]!.map((name, index) => matchParser(options, known, name, id, label + '/' + id + '/' + index));
    selection.set(id, candidates.find(({ plugin }) => plugin.unavailableReason === undefined) ?? candidates[0]!);
  }
  for (const [id, candidates] of providers) {
    if (selection.has(id)) continue;
    if (candidates.length > 1) {
      throw new Error(label + '/' + id + ' is required to choose among ' + candidates.map(({ plugin }) => plugin.id).join(', '));
    }
    selection.set(id, candidates[0]!);
  }
  return { selection, competing };
}

export function inspectionClaims({ claims, providesLanguages }: Plugin): Plugin['claims'] {
  return claims ?? (providesLanguages && claimsForLanguages(providesLanguages));
}

export function selectedSyntax(selection: ReadonlyMap<string, Candidate>) {
  const syntax = new Map<string, LanguageSyntax>();
  for (const [id, { language }] of selection) if (language.syntax !== undefined) syntax.set(id, language.syntax);
  return syntax;
}

/** Uncontested declarations keep their existing report bytes. Contested parsers record their effective scope. */
export function describeProvider(plugin: ParserPlugin, assignments: ReadonlyMap<string, readonly ProvidedLanguage[]>,
  competing: ReadonlySet<string>): ParserPlugin {
  if (!competing.has(plugin.id)) return plugin;
  const chosen = assignments.get(plugin.id);
  const providesLanguages = plugin.providesLanguages?.filter(language => chosen?.includes(language));
  if (providesLanguages?.length) {
    const claims = { languages: providesLanguages.map(({ id }) => id), ...claimsForLanguages(providesLanguages) };
    return { ...plugin, claims, providesLanguages };
  }
  const claims = plugin.operations.some(({ role }) => role === 'inspection') ? inspectionClaims(plugin) : undefined;
  return { ...plugin, claims, providesLanguages: undefined };
}

function claimsForLanguages(languages: readonly ProvidedLanguage[]) {
  return {
    extensions: [...new Set(languages.flatMap(language => language.extensions ?? []))],
    globs: [...new Set(languages.flatMap(language => language.globs ?? []))],
  };
}

function languageCandidates(plugins: readonly ParserPlugin[]): Map<string, Candidate[]> {
  const providers = new Map<string, Candidate[]>();
  for (const plugin of plugins.filter(candidate => candidate.kinds.includes('language'))) {
    const languages = plugin.providesLanguages ?? [];
    for (const language of languages) {
      const candidates = providers.get(language.id) ?? [];
      candidates.push({ plugin, language });
      providers.set(language.id, candidates);
    }
  }
  return providers;
}

function matchParser(options: readonly Candidate[], known: ReadonlySet<string>, name: string, id: string, path: string): Candidate {
  const candidate = options.find(({ plugin }) => plugin.id === name);
  if (candidate) return candidate;
  const available = '; ' + id + ' is provided by ' + options.map(({ plugin }) => plugin.id).join(', ');
  const problem = known.has(name) ? ' names plugin ' + name + ', which does not provide ' + id : ' names unknown plugin ' + name;
  throw new Error(path + problem + available);
}
