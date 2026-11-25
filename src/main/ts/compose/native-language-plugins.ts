import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostToolPath, probeHostTool } from '../api/process/host-tool.js';
import { HostLanguageRunner } from '../api/process/host-language-runner.js';
import { bindProcessPlugin } from '../api/process/plugin.js';
import { pluginApi } from '../core/engine/plugin.js';
import type { Plugin } from '../core/engine/plugin.js';
import { codeStructures } from '../core/model/code-structure.js';
import type { StructureMeasure } from '../core/model/code-structure.js';
import { fileTypes } from '../core/model/file-types.js';
import { duplicationSettings } from '../core/profile/maintainability.js';
import { digest, sourceFiles } from '../core/model/snapshot.js';

export interface NativeLanguagePlugin extends Plugin {
  readonly unavailableReason?: string;
}

const measures = ['functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'commentLines', 'codeLines',
  'structuralRules', 'duplication'] as const;
const descriptors = [
  { id: 'go-ast', language: 'go', binary: 'go', args: ['run'], versionArgs: ['version'], script: 'go/parser.go', measures },
  { id: 'python-ast', language: 'python', binary: 'python3', args: ['-I', '-S'], versionArgs: ['--version'],
    script: 'python/parser.py', measures: [...measures, 'classes'] },
] as const satisfies readonly { id: string; language: string; binary: string; args: readonly string[]; versionArgs: readonly string[];
  script: string; measures: readonly StructureMeasure[] }[];

export const nativeLanguageIds = descriptors.map(({ id }) => id);
let cached: { path: string; plugins: readonly NativeLanguagePlugin[] } | undefined;

export function nativeLanguagePlugins(): readonly NativeLanguagePlugin[] {
  const path = hostToolPath();
  if (cached?.path !== path) cached = { path, plugins: descriptors.map(descriptor => createPlugin(descriptor, path)) };
  return cached.plugins;
}

function createPlugin({ id, language, binary, args, versionArgs, script, measures }: (typeof descriptors)[number],
  path: string): NativeLanguagePlugin {
  const declaration = { ...fileTypes.find(type => type.id === language)!, measures };
  const manifest = { id, version: '1.1.0', api: pluginApi, kinds: ['language'] as const,
    settings: { duplication: duplicationSettings },
    providesLanguages: [declaration], produces: [{ contract: codeStructures.id, persistence: 'transient' as const }] };
  const tool = probeHostTool(binary, versionArgs, path);
  if ('unavailableReason' in tool) {
    return { ...manifest, operations: [], unavailableReason: tool.unavailableReason };
  }
  const parser = fileURLToPath(new URL(`../resources/languages/${script}`, import.meta.resolve('repometry/plugin')));
  return bindProcessPlugin({ ...manifest, tools: { [binary]: tool.version }, operations: [{ id: 'parse', role: 'provider',
    scope: 'repository', fileIndependent: true, inputs: { files: sourceFiles }, output: codeStructures,
    argv: [binary, ...args], timeoutMs: 90_000, maxOutputBytes: 16 * 1024 * 1024, implementation: digest(readFileSync(parser)),
  }] }, new HostLanguageRunner(path, parser, tool));
}
