import { plan } from '../core/engine/plan.js';
import type { Operation, Plugin } from '../core/engine/plugin.js';
import type { SourceFile, SourceSnapshot } from '../core/model/source.js';
import { coverage } from '../plugins/coverage/coverage.js';
import { duplication } from '../plugins/duplication/duplication.js';
import { maintainability } from '../plugins/maintainability/maintainability.js';
import { structure } from '../plugins/structure/structure.js';
import { claimMatcher, defaultLanguages, languageRegistry } from './languages.js';
import type { LanguageProvider } from './languages.js';
import { securityPlugins } from './security-plugins.js';

export const structuralInspections = [structure, maintainability];
export const defaultProvider = defaultLanguages.providers[0]!;

export interface SelectedSource {
  readonly file: SourceFile;
  readonly provider: LanguageProvider | undefined;
}

export interface ClaimedPlugin {
  readonly plugin: Plugin;
  readonly matches: (path: string) => boolean;
}

export function inspectionFileMatcher(additional: readonly Plugin[], languages = defaultLanguages): (path: string) => boolean {
  const matches = [...securityPlugins, ...additional].filter(plugin => !plugin.kinds.includes('language'))
    .map(plugin => claimMatcher(plugin.claims, languages.id));
  return path => matches.some(match => match(path));
}

export function selectAnalysisSources(snapshot: SourceSnapshot, additional: readonly Plugin[], withCoverage: boolean) {
  const languages = additional.length ? languageRegistry(additional) : defaultLanguages;
  const sources: SelectedSource[] = snapshot.files.map(file => ({ file, provider: languages.select(file.path) }));
  const providersByPath = new Map(sources.flatMap(({ file, provider }) => provider ? [[file.path, provider] as const] : []));
  const sourceFiles = sources.flatMap(({ file, provider }) => provider ? [file] : []);
  const bound = new Map(languages.providers.map(({ plugin }) => [plugin.id, plugin]));
  const claimedPlugins = [...securityPlugins.filter(plugin => !additional.includes(plugin)), ...additional.map(plugin => bound.get(plugin.id) ?? plugin)];
  const plugins = [defaultProvider.plugin, ...structuralInspections, duplication, ...(withCoverage ? [coverage] : []), ...claimedPlugins];
  validateRegistration(plugins, additional, withCoverage);
  const claims: ClaimedPlugin[] = claimedPlugins.map(plugin => ({ plugin, matches: plugin.kinds.includes('language')
    ? path => providersByPath.get(path)?.plugin.id === plugin.id : claimMatcher(plugin.claims, languages.id) }));
  return { languages, sources, sourceFiles, providersByPath, plugins, claimedPlugins,
    perFile: claimsForScope(claims, 'file'), repository: claimsForScope(claims, 'repository') };
}

export type AnalysisSources = ReturnType<typeof selectAnalysisSources>;

function validateRegistration(plugins: readonly Plugin[], additional: readonly Plugin[], withCoverage: boolean): void {
  if (additional.length) plan({ plugins, select: [], inputs: new Map() });
  if (!withCoverage && additional.some(plugin => plugin.id === coverage.id)) {
    throw new Error('An additional plugin uses a built-in plugin ID');
  }
}

function claimsForScope(claims: readonly ClaimedPlugin[], scope: NonNullable<Operation['scope']>): ClaimedPlugin[] {
  return claims.map(({ plugin, matches }) => ({ plugin: pluginForScope(plugin, scope), matches }))
    .filter(({ plugin }) => plugin.operations.length > 0);
}

export function pluginForScope(plugin: Plugin, scope: NonNullable<Operation['scope']>): Plugin {
  const operations = plugin.operations.filter(operation => (operation.scope ?? 'file') === scope);
  return operations.length === plugin.operations.length ? plugin : { ...plugin, operations };
}

export function inspectionKeys(plugin: Plugin): string[] {
  return plugin.operations.filter(operation => operation.role === 'inspection').map(operation => `${plugin.id}/${operation.id}`);
}
