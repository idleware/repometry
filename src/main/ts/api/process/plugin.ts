import { isRecord } from '../../core/engine/plugin.js';
import type { InspectionInputs, Operation, Plugin } from '../../core/engine/plugin.js';
import { isJsonValue } from '../../core/model/plugin-data.js';
import type { JsonValue } from '../../core/model/plugin-data.js';
import { digest, sourceFile, sourceFiles, utf8 } from '../../core/model/snapshot.js';
import type { SourceFile } from '../../core/model/source.js';
import type { ToolInvocation, ToolRunner } from '../../core/ports/tool-runner.js';
import { toolFailure } from './failure.js';

export const processPluginProtocol = 'repometry.plugin-process/v1';

export interface ProcessOperation extends Omit<Operation, 'execute'>, Pick<ToolInvocation, 'argv' | 'timeoutMs' | 'maxOutputBytes'> {}

export interface ProcessPluginManifest extends Omit<Plugin, 'operations' | 'tools'> {
  readonly operations: readonly ProcessOperation[];
  readonly tools: Readonly<Record<string, string>>;
}

type ProcessRunner = Pick<ToolRunner, 'run' | 'implementation'>;

export function processPlugin(manifest: ProcessPluginManifest, runner: ToolRunner): Plugin {
  if (runner.network !== 'none') throw new Error('Process plugins require a runner with networking disabled');
  return bindProcessPlugin(manifest, runner);
}

// Only the packaged, first-party parsers use the host runner.
export function bindProcessPlugin({ operations, ...manifest }: ProcessPluginManifest, runner: ProcessRunner): Plugin {
  const versions = Object.values(manifest.tools);
  if (versions.length === 0 || versions.some(version => typeof version !== 'string' || !version.trim())) {
    throw new Error('Process plugins must declare their tool versions');
  }
  return { ...manifest, operations: operations.map(operation => bindOperation(manifest.id, manifest.settings ?? null, operation, runner)) };
}

function bindOperation(plugin: string, settings: JsonValue, operation: ProcessOperation, runner: ProcessRunner): Operation {
  const { id, role, scope, inputs, output, argv, timeoutMs, maxOutputBytes } = operation;
  const implementation = digest(JSON.stringify([processPluginProtocol, operation.implementation, runner.implementation, argv, timeoutMs, maxOutputBytes]));
  return { id, role, scope, inputs, output, implementation, async execute(context) {
    const { files, stdin } = encodeRequest(`${plugin}/${id}`, settings, operation, context);
    const result = await runner.run({ argv, timeoutMs, maxOutputBytes, files, stdin });
    if (result.exitCode !== 0) throw new Error(toolFailure(`Process plugin exited with code ${result.exitCode}`, result.stderr));
    return decodeResponse(result.stdout, output.id, context);
  } };
}

function encodeRequest(key: string, settings: JsonValue, operation: ProcessOperation, context: InspectionInputs) {
  const files = new Map<string, { file: SourceFile; reference: { path: string; sha256: string } }>();

  function referenceFile(file: SourceFile) {
    const reference = { path: file.path, sha256: digest(file.bytes) };
    const existing = files.get(file.path);
    if (existing && existing.reference.sha256 !== reference.sha256) throw new Error(`Conflicting process input file: ${file.path}`);
    files.set(file.path, { file, reference });
    return reference;
  }

  const inputs = Object.fromEntries(Object.entries(operation.inputs).map(([port, contract]) => {
    const value = context.read(port, contract);
    if (contract.id === sourceFile.id) {
      if (!sourceFile.accepts(value)) throw new Error(`Invalid process input file: ${key}.${port}`);
      return [port, { contract: contract.id, file: referenceFile(value) }];
    }
    if (contract.id === sourceFiles.id) {
      if (!sourceFiles.accepts(value)) throw new Error(`Invalid process input file set: ${key}.${port}`);
      return [port, { contract: contract.id, files: value.map(referenceFile) }];
    }
    if (!isJsonValue(value)) throw new Error(`Process input must be JSON data: ${key}.${port}`);
    return [port, { contract: contract.id, value }];
  }));
  const entries = [...files.values()];
  const request = { protocol: processPluginProtocol, operation: key, settings, files: entries.map(({ reference }) => reference), inputs };
  return { files: entries.map(({ file }) => file), stdin: Buffer.from(`${JSON.stringify(request)}\n`) };
}

function decodeResponse(bytes: Uint8Array, contract: string, context: InspectionInputs): JsonValue {
  let product: JsonValue | undefined;
  for (const line of utf8(bytes).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { throw new Error('Invalid JSON Lines output from the process plugin'); }
    if (!isRecord(entry)) throw new Error('Invalid process plugin output record');
    if (entry.kind === 'diagnostic') {
      readDiagnostic(entry, context);
      continue;
    }
    if (entry.kind !== 'product' || entry.contract !== contract || product !== undefined || !isJsonValue(entry.value)) {
      throw new Error('Expected one declared product from the process plugin');
    }
    product = entry.value;
  }
  if (product === undefined) throw new Error('Missing declared product from the process plugin');
  return product;
}

function readDiagnostic(entry: Record<string, unknown>, context: InspectionInputs): void {
  if (typeof entry.message !== 'string' || !entry.message.trim()) throw new Error('Invalid process plugin diagnostic message');
  switch (entry.severity) {
    case undefined:
    case 'info': return;
    case 'warning': context.emitDiagnostic?.(entry.message); return;
    case 'error': throw new Error(entry.message);
    default: throw new Error('Invalid process plugin diagnostic severity');
  }
}
