import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from './helpers/analysis.js';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import { workingSnapshot } from '@repometry/core/internal/model/snapshot.js';
import { mapCoverage } from '../../main/ts/plugins/coverage/coverage.js';
import { inspectionDetails } from '../../main/ts/report/json/projections/inspection-details.js';
import { readReport } from '../../main/ts/report/json/validation/report.js';

const hits = (map: ReadonlyMap<unknown, number> | undefined) => [...map ?? []].filter(([, hit]) => hit).length;

test('LCOV branches and functions are read alongside lines, merged by any hit across reports', () => {
  const unit = [
    'SF:src/a.ts', 'FN:1,run', 'FN:5,run', 'FN:9,(anonymous_2)', 'FNDA:3,run', 'FNDA:0,run', 'FNDA:0,(anonymous_2)',
    'DA:1,3', 'DA:2,0', 'BRDA:2,0,0,1', 'BRDA:2,0,1,0', 'BRDA:7,1,0,-', 'end_of_record',
  ].join('\n');
  const integration = ['SF:src/a.ts', 'FN:1,run', 'FN:5,run', 'FNDA:0,run', 'FNDA:2,run', 'BRDA:2,0,1,4', 'DA:2,1', 'end_of_record'].join('\n');
  const input = { root: '/repo', sourceLines: new Map([['src/a.ts', 10]]) };
  const single = mapCoverage({ ...input, text: unit });
  assert.equal(single.branches.get('src/a.ts')?.size, 3);
  assert.equal(hits(single.branches.get('src/a.ts')), 1);
  // c8 repeats a name for different functions: the second `run` is its own function, paired by occurrence.
  assert.equal(single.functions.get('src/a.ts')?.size, 3);
  assert.equal(hits(single.functions.get('src/a.ts')), 1);

  const merged = mapCoverage({ ...input, text: `${unit}\n${integration}` });
  assert.equal(hits(merged.branches.get('src/a.ts')), 2);
  assert.equal(hits(merged.functions.get('src/a.ts')), 2);
  assert.deepEqual(merged.functionCalls.get('src/a.ts'), [[1, 3], [5, 2], [9, 0]]);
  assert.equal(hits(merged.files.get('src/a.ts')), 2);
});

test('an LCOV without branch or function records reports lines only', () => {
  const lines = mapCoverage({ text: 'SF:src/a.ts\nDA:1,1\nend_of_record', root: '/repo', sourceLines: new Map([['src/a.ts', 1]]) });
  assert.equal(lines.branches.size, 0);
  assert.equal(lines.functions.size, 0);
  assert.throws(() => mapCoverage({ text: 'SF:src/a.ts\nBRDA:x\nend_of_record', root: '/repo', sourceLines: new Map([['src/a.ts', 1]]) }),
    /Invalid LCOV data at line 2/);
});

test('inspections persist sorted, merged line ranges and project only measured files', async () => {
  const unit = [
    'SF:src/a.js', 'DA:9,0', 'DA:7,0', 'DA:3,2', 'DA:6,0', 'DA:2,1', 'DA:5,1',
    'BRDA:2,0,0,1', 'BRDA:2,0,1,0', 'BRDA:5,0,0,1', 'BRDA:5,0,1,-',
    'BRDA:8,0,0,1', 'BRDA:8,0,1,0', 'BRDA:11,0,0,1', 'BRDA:11,0,1,0', 'end_of_record',
    'SF:src/empty.js', 'end_of_record', 'SF:src/gap.js', 'DA:1,1', 'DA:99,1', 'end_of_record',
  ].join('\n');
  const integration = ['SF:src/a.js', 'DA:2,1', 'BRDA:2,0,1,3', 'end_of_record'].join('\n');
  const snapshot = workingSnapshot(['src/a.js', 'src/empty.js', 'src/gap.js'].map(path =>
    ({ path, bytes: Buffer.from('1;\n'.repeat(10)) })));
  const input = { snapshot, excludedOutput: null };
  const report = await analyzeSnapshot({ ...input, coverage: { text: `${unit}\n${integration}`, sourceRoot: '/repo' } });
  const expected = { 'src/a.js': { covered: [[2, 3], [5, 5]], uncovered: [[6, 7], [9, 9]], partial: [[5, 5], [8, 8]],
    hits: [[2, 3, 2], [5, 5, 1], [6, 7, 0], [8, 8, 1], [9, 9, 0]], functionBodies: [] } };
  assert.deepEqual(report.pluginData?.products['repometry.lcov-lines/v1'], [{ operation: 'lcov/lines', value: expected }]);
  assert.deepEqual(inspectionDetails(readReport(JSON.parse(JSON.stringify(report)))).lineCoverage, expected);
  assert.ok(!Object.hasOwn(inspectionDetails(await analyzeSnapshot(input)), 'lineCoverage'));
});

test('blank lines and comment-only lines are excluded from coverage totals, states, and hits', async () => {
  const source = ['const one = 1; // inline', '', '// comment', '/* block', ' * comment */', 'export const two = 2;', ''].join('\n');
  const text = ['SF:a.js', 'DA:1,2', 'DA:2,8', 'DA:3,8', 'DA:4,8', 'DA:5,8', 'DA:6,0',
    'BRDA:3,0,0,1', 'BRDA:3,0,1,0', 'end_of_record'].join('\n');
  const report = await analyzeSnapshot({ snapshot: workingSnapshot([{ path: 'a.js', bytes: Buffer.from(source) }]),
    excludedOutput: null, coverage: { text, sourceRoot: '/repo' } });
  assert.deepEqual(inspectionDetails(report).lineCoverage, {
    'a.js': { covered: [[1, 1]], uncovered: [[6, 6]], hits: [[1, 1, 2], [6, 6, 0]], functionBodies: [] },
  });
  assert.deepEqual(report.measurements.find(row => row.definition === definitions.coverage && row.target === 'repository'),
    { definition: definitions.coverage, target: 'repository', covered: 1, total: 2, value: 0.5 });
});

test('LCOV distinguishes module loads from calls and sums calls for each declaration', async () => {
  const path = 'src/a.js';
  const source = ['const top = 1;', 'export function never() {', '  return top;', '}', 'export function run() {',
    '  return 2;', '}', 'export const inline = () => top;'].join('\n');
  const unit = ['SF:src/a.js', 'FN:2,never', 'FN:5,run', 'FN:8,8,inline', 'FNDA:0,never', 'FNDA:2,run',
    'FNDA:4,inline', 'DA:1,2', 'DA:2,2', 'DA:3,0', 'DA:6,2', 'DA:8,4', 'end_of_record'];
  const integration = ['SF:src/a.js', 'FN:2,never', 'FN:5,run', 'FNDA:0,never', 'FNDA:3,run', 'DA:6,3', 'end_of_record'];
  const report = await analyzeSnapshot({
    snapshot: workingSnapshot([{ path, bytes: Buffer.from(source) }]), excludedOutput: null,
    coverage: { text: [...unit, ...integration].join('\n'), sourceRoot: '/repo' },
  });
  assert.deepEqual(inspectionDetails(readReport(JSON.parse(JSON.stringify(report)))).lineCoverage?.[path], {
    covered: [[1, 2], [6, 6], [8, 8]], uncovered: [[3, 3]],
    hits: [[1, 2, 2], [3, 3, 0], [6, 6, 5], [8, 8, 4]],
    functionCalls: [[2, 0], [5, 5], [8, 4]], functionBodies: [[3, 3], [6, 6], [8, 8]],
  });
});
