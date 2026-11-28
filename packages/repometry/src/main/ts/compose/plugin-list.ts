import type { FileClaims, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { pluginCategory } from '@repometry/core/internal/engine/plugin-manifest.js';
import { selectParsers } from './parser-order.js';
import { registeredPlugins } from './built-ins.js';
import { pluginRegistration } from './registered-plugin.js';
import type { ParserOrder, ParserPlugin } from './parser-order.js';

export function effectivePlugins(additional: readonly Plugin[], parsers?: ParserOrder) {
  const plugins = registeredPlugins(additional);
  selectParsers(plugins, parsers, 'Config parsers');
  return plugins.map(describePlugin);
}

function describePlugin(plugin: ParserPlugin) {
  const { id, version, claims, providesLanguages, unavailableReason, config, rules } = plugin;
  const registration = pluginRegistration(plugin);
  const include = registration?.include ?? includeGlobs(claims);
  return { id, version, category: pluginCategory(plugin), use: registration?.use ?? id,
    versionSource: registration?.versionSource ?? 'built-in', available: unavailableReason === undefined,
    ...(include === undefined ? {} : { include }),
    ...(providesLanguages ? { languages: providesLanguages.map(({ syntax, extensions, globs, measures, ...language }) =>
      ({ ...language, include: includeGlobs({ extensions, globs }) ?? [],
        ...(measures === undefined ? {} : { measures: measures.map(measure => measure === 'structuralRules' ? 'checks' : measure) }) })) } : {}),
    ...(rules === undefined ? {} : { checks: rules.map(({ category, ...check }) => check) }),
    ...(config === undefined ? {} : { optionsSchema: config }),
    ...(registration?.requires === undefined ? {} : { requires: registration.requires }),
    ...(registration?.exclude === undefined ? {} : { exclude: registration.exclude }),
    ...(unavailableReason === undefined ? {} : { reason: unavailableReason }) };
}

function includeGlobs(claims: FileClaims | undefined): readonly string[] | undefined {
  return claims === undefined ? undefined : [...new Set([...(claims.extensions ?? []).map(ext => '**/*' + ext), ...claims.globs ?? []])];
}
