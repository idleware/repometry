import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract, Operation, Plugin } from '../../main/ts/core/engine/plugin.js';
import { changesInput } from '../../main/ts/core/model/changes.js';
import { codeStructure, codeStructures } from '../../main/ts/core/model/code-structure.js';
import type { CodeStructure } from '../../main/ts/core/model/code-structure.js';
import { lcovInput } from '../../main/ts/core/model/coverage-input.js';
import { findingResult } from '../../main/ts/core/model/finding.js';
import { sourceFile, sourceFiles } from '../../main/ts/core/model/snapshot.js';
import { coverage as lcov } from '../../main/ts/plugins/coverage/coverage.js';

// One rule for every plugin: an operation runs in the phase that offers, or whose operations output, all it reads.

const encoder = new TextEncoder();
const files = [['README.md', '# Notes\n'], ['a.ts', 'export const a = 1;\n'], ['b.js', 'module.exports = 2;\n']] as const;
const input = { excludedOutput: null, snapshot: { subject: { kind: 'commit', id: 'a'.repeat(40) } as const,
  files: files.map(([path, text]) => ({ path, bytes: encoder.encode(text) })) } };
const coverage = { text: 'SF:a.ts\nDA:1,1\nend_of_record\n', sourceRoot: '/repo' };
const coverageResult = lcov.operations.find(({ inputs }) => Object.values(inputs).includes(lcovInput))!.output;

const contract = (id: string): DataContract<{ readonly path: string }> =>
  ({ id, accepts: (value): value is { readonly path: string } => typeof (value as { path?: unknown })?.path === 'string' });
const custom = contract('x.custom/v1');
const derived = contract('x.derived/v1');
const nobody = contract('x.nobody/v1');

/** The path an operation's task is about, read from whichever input carries one. */
function pathOf(inputs: Parameters<Operation['execute']>[0], read: Readonly<Record<string, DataContract>>): string {
  for (const [port, input] of Object.entries(read)) {
    const value = inputs.read(port, input) as { path?: unknown } | undefined;
    if (typeof value?.path === 'string') return value.path;
  }
  return '(no path)';
}

function finding(path: string) {
  return { measurements: [], findings: [{ tool: 'x', rule: 'r', category: 'lint', level: 'low', message: 'm', path, line: 1 }] };
}

function inspector(id: string, inputs: Readonly<Record<string, DataContract>>, extra: Partial<Plugin> = {}): Plugin {
  return { id, version: '1.0.0', api: pluginApi, kinds: ['analysis'], rules: [{ id: 'r', category: 'lint' }],
    produces: [{ contract: findingResult.id, persistence: 'report' }],
    operations: [{ id: 'run', role: 'inspection', inputs, output: findingResult, execute: read => finding(pathOf(read, inputs)) }],
    ...extra };
}

function producer(id: string, inputs: Readonly<Record<string, DataContract>>, output: DataContract, extra: Partial<Plugin> = {}): Plugin {
  return { id, version: '1.0.0', api: pluginApi, kinds: ['analysis'], produces: [{ contract: output.id, persistence: 'transient' }],
    operations: [{ id: 'make', role: 'provider', inputs, output, execute: read => ({ path: pathOf(read, inputs), lines: 1, functions: 0 }) }], ...extra };
}

/** A plugin that derives its own code structure and checks it. */
function deriver(claims: Partial<Plugin>): Plugin {
  return { ...producer('x-d', { source: sourceFile }, codeStructure, claims),
    produces: [{ contract: codeStructure.id, persistence: 'transient' }, { contract: findingResult.id, persistence: 'report' }],
    operations: [...producer('x-d', { source: sourceFile }, codeStructure).operations, ...inspector('x-d', { syntax: codeStructure }).operations] };
}

const md = { claims: { extensions: ['.md'] } };
const ts = { claims: { extensions: ['.ts'] } };

const repositoryStructure = producer('x-batch', { files: sourceFiles }, codeStructures, {
  ...md,
  operations: [{
    id: 'make', role: 'provider', scope: 'repository', inputs: { files: sourceFiles }, output: codeStructures,
    execute: inputs => inputs.read('files', sourceFiles).map(({ path }) => ({ path, lines: 1, functions: 0 })),
  }],
});

async function outcome(plugins: readonly Plugin[], withCoverage = false): Promise<string> {
  try {
    const report = await analyzeSnapshot(withCoverage ? { ...input, coverage } : input, plugins);
    const ids = plugins.map(({ id }) => id);
    const operations = (report.appliedConfig.operations as { key: string }[]).map(({ key }) => key)
      .filter(key => ids.some(id => key.startsWith(`${id}/`)));
    const paths = (report.findings ?? []).filter(({ tool }) => tool === 'x').map(({ path }) => path).sort();
    const diagnostics = report.diagnostics.filter(({ operation }) => ids.some(id => operation.startsWith(`${id}/`)));
    assert.deepEqual(diagnostics, []);
    return `runs ${JSON.stringify(operations)} on ${JSON.stringify(paths)}`;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    return `error: ${(error as Error).message}`;
  }
}

const cases: readonly { readonly name: string; readonly plugins: readonly Plugin[]; readonly coverage?: boolean;
  readonly expected: string | RegExp }[] = [
  { name: 'reads nothing and claims nothing: every file', plugins: [inspector('x-n0', {})],
    expected: 'runs ["x-n0/run"] on ["(no path)","(no path)","(no path)"]' },
  { name: 'reads nothing, claims Markdown: claimed files', plugins: [inspector('x-n1', {}, md)], expected: 'runs ["x-n1/run"] on ["(no path)"]' },
  { name: 'reads the source file: claimed files', plugins: [inspector('x-src', { source: sourceFile }, md)], expected: 'runs ["x-src/run"] on ["README.md"]' },
  { name: 'reads code structure, claims Markdown: no parsed file is claimed', plugins: [inspector('x-smd', { syntax: codeStructure }, md)],
    expected: 'runs [] on []' },
  { name: 'reads code structure, claims TypeScript: the parsed files it claims', plugins: [inspector('x-sts', { syntax: codeStructure }, ts)],
    expected: 'runs ["x-sts/run"] on ["a.ts"]' },
  { name: 'reads code structure without claims: parsed files', plugins: [inspector('x-snc', { syntax: codeStructure })],
    expected: 'runs ["x-snc/run"] on ["a.ts","b.js"]' },
  { name: 'reads the coverage input without coverage: inactive', plugins: [inspector('x-lo', { lcov: lcovInput }, ts)], expected: 'runs [] on []' },
  { name: 'reads the coverage input with coverage: once after the files', plugins: [inspector('x-lo', { lcov: lcovInput }, ts)],
    coverage: true, expected: 'runs ["x-lo/run"] on ["(no path)"]' },
  { name: 'reads structure and coverage without coverage: no run offers both in one phase', plugins: [inspector('x-sl', { syntax: codeStructure, lcov: lcovInput })],
    expected: 'error: x-sl/run reads repometry.code-structure/v1, repometry.lcov-input/v1, which no phase of its runs offers together' },
  { name: 'reads the source file and line changes, with or without coverage: no run offers both', plugins: [inspector('x-m', { source: sourceFile, changes: changesInput }, ts)],
    expected: 'error: x-m/run reads repometry.source-file/v1, repometry.git-line-changes/v1, which no phase of its runs offers together' },
  { name: 'reads the repository files and line changes: no run offers both', coverage: true,
    plugins: [{ ...inspector('x-m', { files: sourceFiles, changes: changesInput }), operations: inspector('x-m', { files: sourceFiles, changes: changesInput }).operations.map(operation => ({ ...operation, scope: 'repository' as const })) }],
    expected: 'error: x-m/run reads repometry.source-files/v1, repometry.git-line-changes/v1, which no phase of its runs offers together' },
  { name: 'reads structure and coverage with coverage: offered in different phases', coverage: true,
    plugins: [inspector('x-sl', { syntax: codeStructure, lcov: lcovInput })],
    expected: 'error: x-sl/run reads repometry.code-structure/v1, repometry.lcov-input/v1, which no phase of its runs offers together' },
  { name: 'reads another plugin\'s product, both claiming the file', plugins: [producer('x-producer', { source: sourceFile }, custom, md),
    inspector('x-consumer', { x: custom }, md)], expected: 'runs ["x-producer/make","x-consumer/run"] on ["README.md"]' },
  { name: 'reads another plugin\'s product on files only the consumer claims: its producer did not run there',
    plugins: [producer('x-producer', { source: sourceFile }, custom, md), inspector('x-consumer', { x: custom }, ts)],
    expected: 'error: Missing input x-consumer/run.x (x.custom/v1)' },
  { name: 'three plugins in a chain', plugins: [producer('x-one', { source: sourceFile }, custom, md),
    producer('x-two', { x: custom }, derived, md), inspector('x-three', { y: derived }, md)],
    expected: 'runs ["x-one/make","x-two/make","x-three/run"] on ["README.md"]' },
  { name: 'a chain listed consumer first', plugins: [inspector('x-three', { y: derived }, md),
    producer('x-two', { x: custom }, derived, md), producer('x-one', { source: sourceFile }, custom, md)],
    expected: 'runs ["x-one/make","x-two/make","x-three/run"] on ["README.md"]' },
  { name: 'a product derived from code structure: the parsed files the consumer claims', plugins: [producer('x-shape', { syntax: codeStructure }, custom),
    inspector('x-consumer', { x: custom }, ts)], expected: 'runs ["x-shape/make","x-consumer/run"] on ["a.ts"]' },
  { name: 'a product derived from the coverage input, read with another plugin\'s product: the middle operation is the cause', coverage: true,
    plugins: [producer('x-a', { source: sourceFile }, custom, ts), producer('x-b', { x: custom, lcov: lcovInput }, derived),
      inspector('x-c', { y: derived })], expected: 'error: x-b/make reads x.custom/v1, repometry.lcov-input/v1, which no phase of its runs offers together' },
  { name: 'reads a built-in\'s product without coverage: inactive', plugins: [inspector('x-cov', { coverage: coverageResult })],
    expected: 'runs [] on []' },
  { name: 'reads a built-in\'s product with coverage: after the files', plugins: [inspector('x-cov', { coverage: coverageResult })],
    coverage: true, expected: 'runs ["x-cov/run"] on ["(no path)"]' },
  { name: 'reads line changes: no run it takes part in offers them', plugins: [inspector('x-changes', { changes: changesInput })],
    expected: 'error: x-changes/run reads repometry.git-line-changes/v1, which no phase of its runs offers together' },
  { name: 'reads a contract nothing outputs', plugins: [inspector('x-u', { x: nobody })],
    expected: 'error: x-u/run reads x.nobody/v1, which no plugin outputs' },
  { name: 'reads a product only an unsatisfiable operation outputs', plugins: [producer('x-p', { x: nobody }, custom),
    inspector('x-c', { x: custom })], expected: 'error: x-p/make reads x.nobody/v1, which no plugin outputs' },
  { name: 'reads a product of an operation that reads line changes: that operation is the cause', plugins: [producer('x-p', { changes: changesInput }, custom),
    inspector('x-c', { x: custom })], expected: 'error: x-p/make reads repometry.git-line-changes/v1, which no phase of its runs offers together' },
  { name: 'uses a built-in plugin ID', plugins: [inspector('maintainability', { source: sourceFile })],
    expected: 'error: An additional plugin uses a built-in plugin ID' },
  { name: 'uses the ID of a built-in that the analysis leaves inactive', plugins: [inspector('diff-coverage', { source: sourceFile })],
    expected: 'error: An additional plugin uses a built-in plugin ID' },
  { name: 'uses the ID of a source provider', plugins: [inspector('local', { source: sourceFile })],
    expected: 'error: An additional plugin uses a built-in plugin ID' },
  { name: 'derives code structure for its own check on Markdown: only a language provider supplies it',
    plugins: [deriver(md)], expected: 'error: x-d/make outputs repometry.code-structure/v1, which only a language provider supplies' },
  { name: 'derives code structure for its own check on parsed files: only a language provider supplies it',
    plugins: [deriver(ts)], expected: 'error: x-d/make outputs repometry.code-structure/v1, which only a language provider supplies' },
  { name: 'only a language provider supplies repository code structure', plugins: [repositoryStructure],
    expected: 'error: x-batch/make outputs repometry.code-structures/v1, which only a language provider supplies' },
  { name: 'a registered language provider supplies repository code structure', plugins: [{ ...repositoryStructure, kinds: ['language'],
    providesLanguages: [{ id: 'fixture-text', label: 'Fixture text', extensions: ['.md'] }] }],
    expected: 'runs ["x-batch/make"] on []' },
  { name: 'reads code structure while two other plugins derive one: they are rejected', plugins: [
    producer('x-d1', { source: sourceFile }, codeStructure, ts), producer('x-d2', { source: sourceFile }, codeStructure, ts),
    inspector('x-c', { syntax: codeStructure }, ts)], expected: 'error: x-d1/make outputs repometry.code-structure/v1, which only a language provider supplies' },
  { name: 'reads another plugin\'s product while its own operation reads line changes: that operation is rejected', plugins: [
    producer('x-q', { source: sourceFile }, custom, ts), { ...inspector('x-p', { x: custom, source: sourceFile }, ts),
      produces: [{ contract: custom.id, persistence: 'transient' }, { contract: findingResult.id, persistence: 'report' }],
      operations: [...producer('x-p', { changes: changesInput }, custom).operations, ...inspector('x-p', { x: custom, source: sourceFile }).operations] }],
    expected: 'error: x-p/make reads repometry.git-line-changes/v1, which no phase of its runs offers together' },
  { name: 'reads in a file operation a product its own plugin makes over the repository and another makes per file', plugins: [
    producer('x-q', { source: sourceFile }, custom, ts), { ...inspector('x-p', { x: custom, source: sourceFile }, ts),
      produces: [{ contract: custom.id, persistence: 'transient' }, { contract: findingResult.id, persistence: 'report' }],
      operations: [{ ...producer('x-p', { files: sourceFiles }, custom).operations[0]!, scope: 'repository' as const },
        ...inspector('x-p', { x: custom, source: sourceFile }).operations] }],
    expected: 'runs ["x-q/make","x-p/run"] on ["a.ts"]' },
  { name: 'outputs the source file, which only the host supplies', plugins: [producer('x-f', { x: custom }, sourceFile), producer('x-p', { source: sourceFile }, custom, md)],
    expected: 'error: x-f/make outputs repometry.source-file/v1, which only the host supplies' },
  { name: 'reads a product of a dependency cycle', plugins: [producer('x-a', { y: derived }, custom), producer('x-b', { x: custom }, derived),
    inspector('x-c', { x: custom }, md)], expected: 'error: x-a/make reads x.derived/v1, which only operations that never run output' },
];

for (const { name, plugins, coverage: withCoverage, expected } of cases) {
  test(`a configured plugin: ${name}`, async () => {
    const actual = await outcome(plugins, withCoverage);
    if (typeof expected === 'string') assert.equal(actual, expected);
    else assert.match(actual, expected);
  });
}

test('built-ins follow the same rule: diff coverage and coverage stay inactive without their host inputs', async () => {
  const keys = async (withCoverage: boolean) => ((await analyzeSnapshot(withCoverage ? { ...input, coverage } : input))
    .appliedConfig.operations as { key: string }[]).map(({ key }) => key);
  const plain = await keys(false);
  assert.ok(!plain.some(key => key.startsWith('diff-coverage/') || key.startsWith('lcov/')), plain.join(', '));
  const covered = await keys(true);
  assert.deepEqual(covered.filter(key => key.startsWith('lcov/')), ['lcov/import', 'lcov/lines']);
  assert.ok(!covered.some(key => key.startsWith('diff-coverage/')));
});

test('a plugin that derives a product from code structure reads the structure of the file\'s provider', async () => {
  const seen: string[] = [];
  const shape: Plugin = { ...producer('x-shape', { syntax: codeStructure }, custom), operations: [{ id: 'make', role: 'provider',
    inputs: { syntax: codeStructure }, output: custom, execute: read => {
      const { path, functions } = read.read('syntax', codeStructure) as CodeStructure;
      seen.push(`${path}:${functions}`);
      return { path };
    } }] };
  await analyzeSnapshot(input, [shape, inspector('x-consumer', { x: custom })]);
  assert.deepEqual(seen.sort(), ['a.ts:0', 'b.js:0']);
});

