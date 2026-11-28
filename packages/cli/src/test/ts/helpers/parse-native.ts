import assert from 'node:assert/strict';
import { codeStructure } from '@repometry/core';
import type { CodeStructure, PluginManifest } from '@repometry/core';

export async function parseNative(plugin: PluginManifest, source: string, path: string): Promise<CodeStructure> {
  const { operations } = await plugin.create(undefined, { root: '.' });
  const [operation] = operations;
  assert.ok(operation);
  const result = await operation.execute({
    read: <T>(port: string) => {
      assert.equal(port, 'file');
      return { path, bytes: Buffer.from(source) } as T;
    },
    emitDiagnostic: assert.fail,
  });
  assert.ok(codeStructure.accepts(result));
  return result;
}
