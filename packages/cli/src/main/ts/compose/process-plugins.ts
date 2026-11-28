import { manifestPlugin } from '@repometry/core/internal/engine/plugin-manifest.js';
import { readFile } from 'node:fs/promises';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { JsonValue } from '@repometry/core/internal/model/plugin-data.js';
import { sourceFile, sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import { DockerToolRunner } from '../api/process/docker-tool-runner.js';
import { processPlugin } from '../api/process/plugin.js';
import { dockerLabel, inspectDockerImage } from './docker-image.js';
import { authorOperation } from '@repometry/core/internal/engine/author-operation.js';
import { checkManifest, manifestScope } from './plugin-manifest.js';
import type { Manifest } from './plugin-manifest.js';
import { validatePluginOptions } from './plugin-options.js';
import type { PluginReference } from './plugin-reference.js';
import { readRequirements, unmetRequirement } from './plugin-requirements.js';

interface DockerPluginContext { readonly base: string; readonly packageUrl?: string }

export async function dockerPluginFile(path: string, entry: PluginReference, context: DockerPluginContext) {
  const { base } = context;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(base + '/manifest could not read ' + path, { cause: error });
  }
  if (!isRecord(value) || typeof value.image !== 'string') throw new Error(base + '/manifest/image is required');
  return loadDockerPlugin(value, value.image, entry, context, true);
}

export async function dockerPluginImage(image: string, entry: PluginReference, context: DockerPluginContext) {
  const { base } = context;
  const inspected = await inspectDockerImage(image, base);
  const value = dockerLabel(inspected.config, base);
  if (isRecord(value) && Object.hasOwn(value, 'image')) throw new Error(base + '/manifest/image belongs in a manifest file');
  return loadDockerPlugin(value, inspected.id, entry, context, false);
}

async function loadDockerPlugin(value: unknown, image: string, entry: PluginReference,
  { base, packageUrl }: DockerPluginContext, inspectTag: boolean) {
  const manifest = checkManifest(value, base);
  const transport = checkTransport(manifest, base);
  const options = validatePluginOptions(manifest.optionsSchema, entry.options, base);
  const requirements = readRequirements(manifest.requires, base + '/manifest/requires');
  const unavailableReason = await unmetRequirement({ ...requirements, tools: [...new Set(['docker', ...(requirements.tools ?? [])])] }, packageUrl);
  const resolvedImage = inspectTag && unavailableReason === undefined && !/(^|@)sha256:[a-f0-9]{64}$/.test(image)
    ? (await inspectDockerImage(image, base)).id : image;
  const plugin = configuredPlugin(transport, resolvedImage, options);
  return { ...manifestScope(manifest, base), versionSource: 'manifest', requires: manifest.requires,
    image: unavailableReason === undefined ? resolvedImage : undefined,
    plugin: unavailableReason === undefined ? plugin : { ...plugin, operations: [], unavailableReason } };
}

function checkTransport(manifest: Manifest, base: string) {
  const { version, command, scope, tools } = manifest;
  if (version === undefined) throw new Error(base + '/manifest/version is required');
  if (!command?.[0]?.trim()) throw new Error(base + '/manifest/command/0 must name an executable');
  if (scope === undefined) throw new Error(base + '/manifest/scope is required');
  if (tools === undefined) throw new Error(base + '/manifest/tools must identify executable versions');
  return { ...manifest, version, command, scope, tools };
}

function configuredPlugin(manifest: ReturnType<typeof checkTransport>, image: string, options: JsonValue | undefined) {
  const { version, command, scope, fileIndependent, limits = {}, tools } = manifest;
  const language = manifest.category === 'language';
  const repository = scope === 'repository';
  const output = language ? (repository ? codeStructures : codeStructure) : findingResult;
  const plugin = processPlugin({ ...manifestPlugin(manifest, version), tools,
    ...(options === undefined ? {} : { settings: options }),
    produces: [{ contract: output.id, persistence: language ? 'transient' : 'report' }],
    operations: [{ id: language ? 'parse' : 'inspect', role: language ? 'provider' : 'inspection',
      scope, fileIndependent, inputs: repository ? { files: sourceFiles } : { source: sourceFile }, output,
      argv: command, timeoutMs: limits.timeoutMs ?? 30_000, maxOutputBytes: limits.maxOutputBytes ?? 8 * 1024 * 1024 }],
  }, new DockerToolRunner(image, { memoryBytes: limits.memoryBytes ?? 512 * 1024 * 1024, pidsLimit: limits.pidsLimit ?? 128 }));
  return { ...plugin, operations: plugin.operations.map(operation => authorOperation(plugin.id, manifest.category, operation)) };
}
