import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  bandLabels, bandOf, bandScale, byKey, catalogIndex, commitValue, compareValues, difference, entryValue, firstSortAscending,
  format, isBuiltin, metricSpecs, rollUp, trendGroups,
} from '../../main/ts/report/html/app/viewer-metric-registry.js';
import type { MetricDescriptor, MetricSpec, MetricValues } from '../../main/ts/report/html/app/viewer-metric-registry.js';

interface Row { readonly path: string; readonly analysed?: boolean; readonly values?: MetricValues }
const read = (name: string) => JSON.parse(readFileSync(resolve('src/test/resources/metric-registry', name), 'utf8'));
const summary = read('summary.json') as { metrics: MetricDescriptor[]; commits: { sha: string; values: MetricValues }[] };
const details = read('details.json') as { catalog: MetricDescriptor[]; files: Row[]; directories: Row[] };
const specs = metricSpecs([...summary.metrics, ...details.catalog]);
const spec = (id: string): MetricSpec => specs.find(candidate => candidate.descriptor.id === id)!;
const todo = spec('fixture.todo-count/v1');
const coverage = spec('repometry.lcov-line-coverage/v1');
const history = catalogIndex(summary.metrics);
const local = catalogIndex(details.catalog);
const [latest, enabled, initial] = summary.commits as [typeof summary.commits[0], typeof summary.commits[0], typeof summary.commits[0]];

test('a plugin metric the viewer has no code for gets a column, a query key, a hotspot choice and a trend', () => {
  assert.equal(specs.length, summary.metrics.length);
  assert.equal(isBuiltin(todo.descriptor), false);
  assert.equal(isBuiltin(coverage.descriptor), true);
  assert.equal(todo.key, 'todo-count');
  assert.equal(todo.short, 'TODO comments');
  assert.deepEqual([todo.column, todo.hotspot, todo.trend], [true, true, true]);
  assert.equal(byKey(specs, local).get('todo-count'), todo);
});

test('a metric without a better is listed but neither shown first nor ranked, and without a roll-up has no trend', () => {
  const owners = spec('fixture.file-owners/v1');
  assert.deepEqual([owners.column, owners.hotspot, owners.trend], [false, false, false]);
  const lines = spec('repometry.code-lines-babel/v1');
  assert.deepEqual([lines.key, lines.short, lines.column, lines.hotspot, lines.trend], ['lines', 'Code lines', false, false, true]);
});

test('built-in metrics keep their query words and plugin metrics group under the plugin after the curated groups', () => {
  assert.equal(spec('repometry.cyclomatic-babel/v1').key, 'complexity');
  assert.equal(coverage.key, 'coverage');
  assert.deepEqual(trendGroups(specs).map(([group, members]) => [group, members.map(member => member.key)]), [
    ['Maintainability', ['complexity', 'remediation-minutes']],
    ['Coverage', ['coverage']],
    ['Size', ['lines']],
    ['fixture', ['todo-count']],
  ]);
});

test('two plugins naming the same metric keep their plugin in the key, as does a reserved word; two versions share it', () => {
  const descriptor = (id: string): MetricDescriptor => ({ id, label: id, unit: 'count', scope: 'file', aggregate: 'sum', better: 'lower' });
  const keys = metricSpecs([descriptor('fixture.todo-count/v1'), descriptor('lint.todo-count/v1'), descriptor('lint.has/v1')]).map(item => item.key);
  assert.deepEqual(keys, ['fixture.todo-count', 'lint.todo-count', 'lint.has']);
  const versions = metricSpecs([descriptor('fixture.todo-count/v1'), descriptor('fixture.todo-count/v2')]);
  assert.deepEqual(versions.map(item => item.key), ['todo-count', 'todo-count']);
  assert.equal(byKey(versions, catalogIndex([versions[0]!.descriptor])).get('todo-count'), versions[0]);
  assert.equal(byKey(versions, catalogIndex([versions[1]!.descriptor])).get('todo-count'), versions[1]);
});

test('a commit that did not measure a metric has no value, so the trend line breaks instead of dropping to zero', () => {
  assert.deepEqual(summary.commits.map(commit => commitValue(history, commit, todo)), [7, 9, null]);
  assert.deepEqual(summary.commits.map(commit => commitValue(history, commit, coverage)), [0.75, 150 / 230, null]);
  assert.equal(commitValue(history, latest, spec('fixture.file-owners/v1')), null);
  assert.equal(commitValue(history, {}, todo), null);
  assert.equal(initial.sha, 'a'.repeat(40));
  assert.equal(enabled.values[6], 9);
});

test('file values resolve against the detail’s own catalog, whatever order the history gives it', () => {
  assert.notEqual(history.get(todo.descriptor.id), local.get(todo.descriptor.id));
  assert.deepEqual(details.files.map(file => entryValue(local, file, todo)), [5, 2, 0, null]);
  assert.deepEqual(details.files.map(file => entryValue(local, file, coverage)), [0.75, 0.9, 0, null]);
  assert.equal(entryValue(local, details.directories[0]!, todo), 7);
  assert.equal(entryValue(local, details.files[0]!, spec('repometry.cyclomatic-babel/v1')), null);
});

test('a folder the viewer gathers rolls its files up by each metric’s aggregate, skipping files nobody analysed', () => {
  const values = rollUp(details.catalog, details.files)!;
  assert.deepEqual(values, { 0: 7, 1: 180, 2: 240 });
  assert.equal(entryValue(local, { values }, coverage), 0.75);
  assert.equal(rollUp(undefined, details.files), undefined);
});

test('values format and change by unit, coloured only where the metric has a better', () => {
  assert.equal(format(todo, 1234), '1,234');
  assert.equal(format(coverage, 0.756), '75.6%');
  assert.equal(format(spec('repometry.remediation-minutes/v1'), 95), '1 h 35 min');
  assert.equal(format(todo, null), '—');
  assert.deepEqual(difference(todo, 7, 9), { text: '−2', direction: 'better' });
  assert.deepEqual(difference(coverage, 0.75, 150 / 230), { text: '+9.8 pp', direction: 'better' });
  assert.deepEqual(difference(spec('repometry.remediation-minutes/v1'), 95, 110), { text: '−15 min', direction: 'better' });
  assert.deepEqual(difference(spec('repometry.code-lines-babel/v1'), 300, 280), { text: '+20', direction: 'neutral' });
  assert.deepEqual(difference(todo, 7, 7), { text: 'No change', direction: 'same' });
});

test('the first sort puts the worst first and missing values last in both directions', () => {
  assert.equal(firstSortAscending(todo), false);
  assert.equal(firstSortAscending(coverage), true);
  const values = [2, null, 5, 0];
  assert.deepEqual([...values].sort(compareValues(false)), [5, 2, 0, null]);
  assert.deepEqual([...values].sort(compareValues(true)), [0, 2, 5, null]);
});

test('bands come from the limits where the descriptor has them, otherwise from the highest value shown', () => {
  assert.equal(bandScale(todo), 'heat');
  assert.equal(bandScale(spec('repometry.code-lines-babel/v1')), 'neutral');
  assert.deepEqual([0, 2, 5].map(value => bandOf(todo, value, 5)), [0, 2, 4]);
  assert.equal(bandOf(todo, 0, 0), 0);
  assert.equal(bandLabels(todo), null);
  const complexity = spec('repometry.cyclomatic-babel/v1');
  assert.deepEqual([1, 5, 6, 20, 51].map(value => bandOf(complexity, value, 51)), [0, 0, 1, 2, 4]);
  assert.deepEqual(bandLabels(complexity), ['≤5', '6–10', '11–20', '21–50', '51+']);
});

test('where higher is better the scale turns round, so the worst band is still red', () => {
  assert.deepEqual([0.95, 0.85, 0.75, 0.65, 0.5].map(value => bandOf(coverage, value, 1)), [0, 1, 2, 3, 4]);
  assert.deepEqual([0.9, 0.6, 0.5999].map(value => bandOf(coverage, value, 1)), [0, 3, 4]);
  assert.deepEqual(bandLabels(coverage), ['90%+', '80–90%', '70–80%', '60–70%', '<60%']);
});

test('a Repometry metric the viewer has no code for goes by its descriptor, and the counts behind a ratio read through it', () => {
  const coverage = (kind: string): MetricDescriptor[] => [
    { id: `repometry.lcov-${kind}-coverage/v1`, label: `${kind} coverage`, unit: 'ratio', scope: 'file', aggregate: 'sum', better: 'higher',
      ratio: { of: `repometry.lcov-covered-${kind}es/v1`, over: `repometry.lcov-coverable-${kind}es/v1` }, group: 'Coverage' },
    { id: `repometry.lcov-covered-${kind}es/v1`, label: 'Covered', unit: 'count', scope: 'file', aggregate: 'sum', better: 'higher', group: 'Coverage' },
    { id: `repometry.lcov-coverable-${kind}es/v1`, label: 'Measured', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Coverage' },
  ];
  const [ratio, covered, coverable] = metricSpecs(coverage('branch')) as [MetricSpec, MetricSpec, MetricSpec];
  assert.equal(isBuiltin(ratio.descriptor), false);
  assert.deepEqual([ratio.key, covered.key, coverable.key], ['branch-coverage', 'covered-branches', 'coverable-branches']);
  // Its own column is there to pick, not shown first; it ranks hotspots and has a trend.
  assert.deepEqual([ratio.column, ratio.hotspot, ratio.trend, ratio.ratioPart], [false, true, true, false]);
  for (const part of [covered, coverable]) assert.deepEqual([part.column, part.hotspot, part.trend, part.ratioPart], [false, false, false, true]);
  // The metrics drawn by hand stay built in, whatever the catalog says of them.
  assert.equal(isBuiltin(spec('repometry.lcov-covered-lines/v1').descriptor), true);
  assert.equal(spec('repometry.lcov-covered-lines/v1').trend, false);
});
