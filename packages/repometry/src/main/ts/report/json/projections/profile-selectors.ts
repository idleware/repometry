import { isRecord } from '../../../core/engine/plugin.js';
import { comparePaths } from '../../../core/model/snapshot.js';
import type { Report } from '../validation/report.js';

export function presentLanguages(inventory: NonNullable<Report['pluginData']>['inventory']) {
  const present = new Map<string, Set<string>>();
  for (const { provider, language } of inventory ?? []) {
    if (!provider) continue;
    const id = provider.slice(0, provider.lastIndexOf('/'));
    const languages = present.get(id) ?? new Set<string>();
    languages.add(language);
    present.set(id, languages);
  }
  return present;
}

export function presentSelectors(plugins: unknown, present: ReadonlyMap<string, ReadonlySet<string>>) {
  const entries: unknown[] = Array.isArray(plugins) ? plugins : [];
  const declarations = entries.filter(isRecord).flatMap(({ id, providesLanguages, claims }) => {
    const languages = typeof id === 'string' ? present.get(id) : undefined;
    if (!languages) return [];
    if (!Array.isArray(providesLanguages)) return isRecord(claims) ? [claims] : [];
    return providesLanguages.filter(isRecord).filter(({ id }) => typeof id === 'string' && languages.has(id));
  });
  const values = (key: 'extensions' | 'globs') => ordered(declarations.flatMap(item => stringList(item[key]) ?? []));
  return { extensions: values('extensions'), globs: values('globs') };
}

export function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string') ? value : null;
}

export function ordered(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(comparePaths);
}
