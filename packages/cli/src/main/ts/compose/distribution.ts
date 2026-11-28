import { bundledPlugin } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { BundledManifest } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';
import { duplicationSettings } from '@repometry/core/internal/profile/maintainability.js';
import type { ParserOrder } from './parser-order.js';

export interface Distribution {
  readonly bundled: readonly Plugin[];
  readonly parsers?: ParserOrder;
  readonly moduleUrl?: string;
  readonly packageUrl?: string;
  readonly resolvePackage?: (name: string) => { readonly url: string; readonly manifest: string | undefined };
}

export const slimDistribution: Distribution = { bundled: [] };

export function distributionParsers(distribution?: Distribution, user?: ParserOrder): ParserOrder | undefined {
  return distribution?.parsers === undefined ? user : { ...distribution.parsers, ...user };
}

export function bundleLanguage(manifest: BundledManifest, language: ProvidedLanguage, requiresSource?: true): Plugin {
  return { ...bundledPlugin(manifest),
    providesLanguages: [language],
    ...(requiresSource === undefined ? {} : { languageProvenanceRequiresSource: requiresSource }),
    settings: { duplication: { ...duplicationSettings, minTokens: duplicationSettings.minNodes } } };
}
