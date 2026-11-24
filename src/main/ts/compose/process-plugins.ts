import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import schema from '../../resources/config/process-plugins-v1.schema.json' with { type: 'json' };
import { DockerToolRunner } from '../api/process/docker-tool-runner.js';
import { processPlugin } from '../api/process/plugin.js';
import { pluginApi } from '../core/engine/plugin.js';
import type { FileClaims, Plugin } from '../core/engine/plugin.js';
import { codeStructure, codeStructures } from '../core/model/code-structure.js';
import type { ProvidedLanguage } from '../core/model/language.js';
import type { JsonValue } from '../core/model/plugin-data.js';
import { sourceFile, sourceFiles } from '../core/model/snapshot.js';
import { languageRegistry } from './languages.js';
import { builtInPluginIds } from './plugin-list.js';

type Selectors = Pick<FileClaims, 'extensions' | 'globs'>;

interface ProcessDefinition {
  readonly id: string;
  readonly version: string;
  readonly image: string;
  readonly command: readonly string[];
  readonly scope: 'file' | 'repository';
  readonly fileIndependent?: boolean;
  readonly claims?: Selectors;
  readonly limits?: Readonly<Partial<Record<'timeoutMs' | 'maxOutputBytes' | 'memoryBytes' | 'pidsLimit', number>>>;
  readonly tools: Readonly<Record<string, string>>;
  readonly settings?: JsonValue;
  readonly providesLanguages: readonly ProvidedLanguage[];
}

let check: ValidateFunction<readonly ProcessDefinition[]> | undefined;

export function readProcessPlugins(value: unknown): readonly Plugin[] {
  if (value === undefined) return [];
  const validate = check ??= new Ajv2020().compile<readonly ProcessDefinition[]>(schema);
  if (!validate(value)) {
    const error = validate.errors?.[0];
    throw new Error(`Config plugins${error?.instancePath ?? ''} ${error?.message ?? 'is invalid'}`);
  }
  const ids = new Set(builtInPluginIds);
  const plugins = value.map((definition, index) => {
    if (ids.has(definition.id)) throw new Error(`Config plugins/${index}/id duplicates plugin ${definition.id}`);
    ids.add(definition.id);
    return configuredPlugin(definition, index);
  });
  languageRegistry(plugins, false);
  return plugins;
}

function configuredPlugin(definition: ProcessDefinition, index: number): Plugin {
  const { id, version, image, command, scope, fileIndependent, claims, limits = {}, tools, settings, providesLanguages } = definition;
  const base = `Config plugins/${index}`;
  if (!command[0]?.trim()) throw new Error(`${base}/command/0 must name an executable`);
  const languages = providesLanguages.map((language, languageIndex) => {
    const selectors = providesLanguages.length === 1 ? { ...claims, ...language } : language;
    if (!selectors.extensions?.length && !selectors.globs?.length) {
      throw new Error(`${base}/providesLanguages/${languageIndex} must claim an extension or glob`);
    }
    return selectors;
  });
  const effective = effectiveClaims(languages, claims, base);
  const repository = scope === 'repository';
  const output = repository ? codeStructures : codeStructure;
  return processPlugin({ id, version, api: pluginApi, kinds: ['language'], tools, claims: effective, providesLanguages: languages,
    ...(settings === undefined ? {} : { settings }),
    produces: [{ contract: output.id, persistence: 'transient' }],
    operations: [{ id: 'parse', role: 'provider', scope, fileIndependent, inputs: repository ? { files: sourceFiles } : { source: sourceFile },
      output, argv: command, timeoutMs: limits.timeoutMs ?? 30_000, maxOutputBytes: limits.maxOutputBytes ?? 8 * 1024 * 1024 }],
  }, new DockerToolRunner(image, { memoryBytes: limits.memoryBytes ?? 512 * 1024 * 1024, pidsLimit: limits.pidsLimit ?? 128 }));
}

function effectiveClaims(languages: readonly ProvidedLanguage[], declared: Selectors | undefined, base: string): Selectors {
  const selectors: Partial<Record<'extensions' | 'globs', readonly string[]>> = {};
  for (const key of ['extensions', 'globs'] as const) {
    const union = new Set(languages.flatMap(language => language[key] ?? []));
    const expected = declared?.[key];
    if (expected !== undefined && (expected.length !== union.size || expected.some(value => !union.has(value)))) {
      throw new Error(`${base}/claims/${key} must match the claims of its languages`);
    }
    if (union.size) selectors[key] = [...union];
  }
  return selectors;
}
