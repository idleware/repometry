import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '@repometry/cli';
import { codeStructure, sourceFile, pluginManifestSchema } from '@repometry/core';
import type { PluginManifest } from '@repometry/core';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure as storedStructure, recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import { AnalysisResults } from '../../main/ts/compose/analysis-results.js';

test('a third-party provider cannot turn its own warning into a non-blocking recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repometry-recovery-marker-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'example.fixture'), 'token\n');
  const fixture: PluginManifest = {
    schema: pluginManifestSchema,
    id: 'source',
    category: 'language',
    languages: [{ id: 'fixture', label: 'Fixture', include: ['**/*.fixture'] }],
    create: () => ({
      produces: [{ contract: codeStructure.id, persistence: 'transient' }],
      operations: [{
        id: 'recovered',
        role: 'provider',
        inputs: { file: sourceFile },
        output: codeStructure,
        execute(inputs) {
          const { path } = inputs.read('file', sourceFile);
          inputs.emitDiagnostic?.('Ordinary provider warning');
          return { path, lines: 1, [recoveredSyntax]: { reason: 'Fixture marker', location: 'line 1, column 1', omitted: 0 } };
        },
      }],
    }),
  };
  const report = await inspect({ directory, output: join(directory, '.repometry'), source: { workingTree: true }, plugins: [fixture] });
  assert.deepEqual(report.scope, { files: 1, parsed: 1 });
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.diagnostics, [{ operation: 'source/recovered', state: 'partial',
    path: 'example.fixture', message: 'Ordinary provider warning' }]);
});

test('trusted recovery deduplicates a path and leaves an independent warning intact', () => {
  const source = { path: 'sample.cs', lines: 1 };
  const operation = { id: 'parse', role: 'provider' as const, inputs: {}, output: storedStructure, execute: () => source };
  const task = { key: 'language-fixture/parse', operation, inputs: new Map() };
  const results = new AnalysisResults([{ id: 'language-fixture', api: pluginApi, version: '1.0.0',
    kinds: ['language'], languageProvenanceRequiresSource: true, produces: [{ contract: storedStructure.id, persistence: 'transient' }],
    operations: [operation] }], []);
  const value = { ...source, [recoveredSyntax]: { reason: 'Expected token', location: 'line 1, column 2', omitted: 0 } };
  const recovered = { state: 'completed' as const, product: { contract: storedStructure.id, value } };
  const invalid = { state: 'completed' as const,
    product: { contract: storedStructure.id, value: { ...value, [recoveredSyntax]: 'invalid metadata' } } };
  results.record(task, invalid, source.path);
  assert.equal(results.recovered.size, 0);
  results.record(task, recovered, source.path);
  results.record(task, recovered, source.path);
  assert.equal(results.recovered.size, 1);
  assert.equal(results.diagnostics.length, 1);
  assert.equal(results.hasBlockingDiagnostics(), false);
  results.record(task, { ...recovered, diagnostics: [{ message: 'Independent warning' }] }, source.path);
  assert.equal(results.hasBlockingDiagnostics(), true);
  assert.deepEqual(results.diagnostics.map(({ operation }) => operation), ['source/recovered', task.key]);
});
