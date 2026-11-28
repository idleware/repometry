import { authorOperation } from '@repometry/core/internal/engine/author-operation.js';
import { manifestPlugin } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';
import { duplicationSettings } from '@repometry/core/internal/profile/maintainability.js';
import goManifest, { go } from '@repometry/language-go';
import pythonManifest, { python } from '@repometry/language-python';
import javaManifest, { java } from '@repometry/language-java';
import phpManifest, { php } from '@repometry/language-php';

type NativeManifest = typeof goManifest;

export const languagePlugins = [nativePlugin(goManifest, go.language), nativePlugin(pythonManifest, python.language),
  nativePlugin(javaManifest, java.language, true), nativePlugin(phpManifest, php.language, true)];

function nativePlugin(manifest: NativeManifest, language: ProvidedLanguage, requiresSource?: true): Plugin {
  const { operations, produces } = manifest.create();
  return { ...manifestPlugin(manifest, manifest.version),
    providesLanguages: [language],
    ...(requiresSource === undefined ? {} : { languageProvenanceRequiresSource: requiresSource }),
    settings: { duplication: { ...duplicationSettings, minTokens: duplicationSettings.minNodes } },
    produces, operations: operations.map(operation => authorOperation(manifest.id, manifest.category, operation)) };
}
