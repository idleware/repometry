import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from '../../main/ts/core/engine/execute.js';
import { plan } from '../../main/ts/core/engine/plan.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { Plugin } from '../../main/ts/core/engine/plugin.js';
import { codeStructure } from '../../main/ts/core/model/code-structure.js';
import type { CodeStructure } from '../../main/ts/core/model/code-structure.js';
import { definitions, measurements } from '../../main/ts/core/model/measurement.js';
import { sourceFile } from '../../main/ts/core/model/snapshot.js';
import { fileQuality, maintainability } from '../../main/ts/plugins/maintainability/maintainability.js';
import { structure } from '../../main/ts/plugins/structure/structure.js';

test('structure and maintainability consume facts from a language provider without a Babel tree', async () => {
  const facts: CodeStructure = {
    path: 'fixture.js', lines: 10, functions: 1, classes: 0, cognitiveComplexity: 3, commentLines: 1,
    cyclomaticFunctions: [{ line: 2, column: 1, name: 'choose', value: 4 }],
    cognitiveFunctions: [{ line: 2, column: 1, name: 'choose', value: 3 }],
    observations: [{ rule: 'function-parameters', value: 7, label: 'choose · Parameters', line: 2, endLine: 8 }],
    clones: { path: 'fixture.js', codeLines: [2, 3, 4, 5, 6, 7, 8], candidates: [] },
  };
  assert.equal(codeStructure.accepts({ ...facts, observations: [{ rule: 'unrecognized', value: 1, label: 'Bad rule' }] }), false);
  const provider: Plugin = {
    id: 'fixture-provider', version: '1.0.0', api: pluginApi, kinds: ['language'],
    claims: { languages: ['javascript'] },
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { source: sourceFile }, output: codeStructure, execute: () => facts }],
  };
  const tasks = plan({ plugins: [provider, structure, maintainability],
    select: ['structure/size', 'structure/complexity', 'maintainability/file'], inputs: new Map([['file', sourceFile.id]]) });
  const results = await execute(tasks, new Map([['file', { contract: sourceFile.id, value: { path: facts.path, bytes: new Uint8Array() } }]]));
  const complexity = results.get('structure/complexity');
  assert.ok(complexity?.state === 'completed' && measurements.accepts(complexity.product.value));
  assert.deepEqual(complexity.product.value, [{
    definition: definitions.complexity, target: 'function', path: 'fixture.js', line: 2, column: 1, name: 'choose', value: 4,
  }]);
  const quality = results.get('maintainability/file');
  assert.ok(quality?.state === 'completed' && fileQuality.accepts(quality.product.value));
  assert.equal(quality.product.value.findings[0]?.effortMinutes, 20);
  assert.equal(quality.product.value.measurements.find(row => row.definition === definitions.codeLines)?.value, 7);
});
