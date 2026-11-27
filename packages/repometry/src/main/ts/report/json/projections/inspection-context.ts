import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../../core/engine/plugin.js';
import { findingImportMethods } from '../../../core/model/scanner-import.js';
import { nativeScanners, securityCounts } from './security-summary.js';
import { normalizeFindingIgnore } from '../../../core/model/finding-ignore.js';
import type { Report } from '../validation/report.js';
import { comparePaths, digest } from '../../../core/model/snapshot.js';

import { ordered, presentLanguages, presentSelectors, stringList } from './profile-selectors.js';
import type { InspectionContext } from '../wire/inspection-context-model.js';

export function inspectionProfileDigest(report: Report): string | undefined {
  const profile = readProfile(report);
  return profile ? digest(JSON.stringify(profile.settings, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => comparePaths(a, b))) : value)) : undefined;
}

export function inspectionContext(report: Report): InspectionContext | undefined {
  if (report.subject.kind !== 'commit') return undefined;
  return { exclusions: readProfile(report)?.exclusions ?? null, boundary: null,
    ...scannerContext(report), ...ignoreContext(report) };
}

function ignoreContext(report: Report): Pick<InspectionContext, 'ignores'> {
  if (report.appliedConfig.findingIgnore === undefined) return {};
  try {
    const rules = normalizeFindingIgnore(report.appliedConfig.findingIgnore);
    return { ignores: { rules, count: report.ignoredFindings?.length ?? 0 } };
  } catch {
    return {};
  }
}

function scannerContext(report: Report): Pick<InspectionContext, 'security' | 'scanners'> {
  const methods = findingImportMethods(report.appliedConfig.findingImports);
  const sources = [...methods.flatMap(({ tools }) => tools), ...nativeScanners(report)];
  if (!methods.length && !sources.length) return {};
  const scanners = [...new Map(sources.map(tool => [JSON.stringify(tool), tool] as const)).values()];
  const security = securityCounts(report);
  return security ? { scanners, security } : { scanners };
}

function readProfile({ appliedConfig: config, pluginData }: Report) {
  const source = config.source;
  if (!isRecord(source)) return null;
  // The original JS/TS profile recorded directory exclusions before path rules existed.
  const recordedPaths = config.profile === 'js-ts/v1' && source.excludedPaths === undefined ? [] : source.excludedPaths;
  const paths = stringList(recordedPaths);
  const directories = stringList(source.excludedDirectories);
  if (!paths || !directories) return null;
  const extensions = stringList(source.extensions);

  let coverage = config.coverage;
  if (isRecord(coverage)) {
    const { inputDigest, inputDigests, pathBase, ...settings } = coverage;
    coverage = settings;
  }
  const { churnWindow, securityScanners, ...settings } = config;
  const toolchain = historicalPluginTools(settings.plugins);
  const present = config.profile === 'repository/v4' ? presentLanguages(pluginData?.inventory) : undefined;
  const plugins = Array.isArray(toolchain) ? toolchain.map(plugin => {
    if (!isRecord(plugin)) return plugin;
    const { providesLanguages, ...entry } = plugin;
    if (present && typeof entry.id === 'string' && Array.isArray(providesLanguages)
      && Array.isArray(entry.kinds) && entry.kinds.every(kind => kind === 'language')) {
      delete entry.claims;
      entry.providesLanguages = ordered([...present.get(entry.id) ?? []]);
    }
    if (entry.id === legacySyntaxPlugin && isDeepStrictEqual(entry.settings, config.parser)) delete entry.settings;
    return entry;
  }) : toolchain;
  // The policy is stable across commits; its matched paths describe this snapshot alone.
  const { generatedExcluded, ...sourceSettings } = source;
  const selectors = present ? presentSelectors(toolchain, present)
    : { extensions: extensions ? ordered(extensions) : source.extensions };
  return {
    exclusions: { paths: [...new Set([...(stringList(source.defaultExclusions) ?? []), ...paths, ...(stringList(generatedExcluded) ?? [])])], directories },
    settings: { ...settings, ...(plugins === undefined ? {} : { plugins }), coverage,
      findingImports: findingImportMethods(config.findingImports), source: { ...sourceSettings,
      ...selectors,
      excludedPaths: ordered(paths), excludedDirectories: ordered(directories),
    } },
  };
}

export const legacySyntaxPlugin = 'babel-syntax';

// Keep history comparable when the parser starts recording its own tool versions.
function historicalPluginTools(plugins: unknown): unknown {
  if (!Array.isArray(plugins)) return plugins;
  const syntax = plugins.find(entry => isRecord(entry) && entry.id === legacySyntaxPlugin);
  if (!isRecord(syntax?.tools)) return plugins;
  const { '@babel/types': types, ...native } = syntax.tools;
  if (typeof types !== 'string') return plugins;
  return plugins.map(entry => {
    if (entry === syntax) return { ...syntax, tools: native };
    if (!isRecord(entry) || (entry.id !== 'structure' && entry.id !== 'maintainability') || !isRecord(entry.tools)) return entry;
    return { ...entry, tools: { '@babel/types': types, ...entry.tools } };
  });
}
