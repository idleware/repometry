import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from '../../main/ts/core/engine/execute.js';
import { plan } from '../../main/ts/core/engine/plan.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract, MetricDescriptor, Plugin } from '../../main/ts/core/engine/plugin.js';

const a: DataContract<number> = { id: 'test.a/v1', accepts: (value): value is number => typeof value === 'number' };
const b: DataContract<number> = { ...a, id: 'test.b/v1' };
const testProducts = [a, b].map(({ id }) => ({ contract: id, persistence: 'transient' as const }));

test('two inspections share a provider and a provider failure blocks both', async () => {
  let calls = 0;
  const plugin: Plugin = { id: 'fixture', api: pluginApi, version: '1', kinds: ['analysis'], produces: testProducts, operations: [
    { id: 'parse', role: 'provider', inputs: { raw: a }, output: b, execute: inputs => {
      calls++;
      const value = inputs.read('raw', a);
      if (value < 0) throw new Error('invalid fixture input');
      return value;
    } },
    { id: 'first', role: 'inspection', inputs: { syntax: b }, output: a, execute: inputs => inputs.read('syntax', b) + 1 },
    { id: 'second', role: 'inspection', inputs: { syntax: b }, output: a, execute: inputs => inputs.read('syntax', b) + 2 },
  ] };
  const tasks = plan({ plugins: [plugin], select: ['fixture/first', 'fixture/second'], inputs: new Map([['raw', a.id]]),
    bindings: new Map([['fixture/parse', { raw: { external: 'raw' } }]]) });
  const reports = await execute(tasks, new Map([['raw', { contract: a.id, value: 10 }]]));
  assert.deepEqual(reports.get('fixture/first'), { state: 'completed', product: { contract: a.id, value: 11 } });
  assert.deepEqual(reports.get('fixture/second'), { state: 'completed', product: { contract: a.id, value: 12 } });
  assert.equal(calls, 1);

  const failed = await execute(tasks, new Map([['raw', { contract: a.id, value: -1 }]]));
  assert.equal(failed.get('fixture/parse')?.state, 'failed');
  assert.equal(failed.get('fixture/first')?.state, 'blocked');
  assert.equal(failed.get('fixture/second')?.state, 'blocked');
  assert.equal(calls, 2);
});

test('an explicit binding must match the contract and dependency cycles fail planning', () => {
  const plugin: Plugin = { id: 'fixture', api: pluginApi, version: '1', kinds: ['analysis'], produces: testProducts, operations: [
    { id: 'left', role: 'provider', inputs: { right: b }, output: a, execute: () => 1 },
    { id: 'right', role: 'provider', inputs: { left: a }, output: b, execute: () => 1 },
  ] };
  assert.throws(() => plan({ plugins: [plugin], select: ['fixture/left'], inputs: new Map() }), /dependency cycle/i);
  const request = { plugins: [plugin], select: ['fixture/left'], inputs: new Map([['raw', a.id]]) };
  assert.throws(() => plan({ ...request, bindings: new Map([['fixture/left', { right: { external: 'raw' } }]]) }), /incompatible input/i);
  assert.throws(() => plan(request), /ambiguous input/i);
});

test('manifest operations must declare every output and custom report products need a schema', () => {
  const plugin: Plugin = {
    id: 'fixture', api: pluginApi, version: '1', kinds: ['analysis'],
    produces: [{ contract: a.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'inspection', inputs: {}, output: b, execute: () => 1 }],
  };
  const request = { plugins: [plugin], select: ['fixture/read'], inputs: new Map() };
  assert.throws(() => plan(request), /undeclared output.*test\.b\/v1/i);
  const produces = [{ contract: b.id, persistence: 'report' }] as const;
  assert.throws(() => plan({ ...request, plugins: [{ ...plugin, produces }] }), /schema.*test\.b\/v1/i);
  const declared = { ...produces[0], schema: { type: 'number' } };
  const [task] = plan({ ...request, plugins: [{ ...plugin, produces: [declared] }] });
  assert.deepEqual(task?.declaration, declared);
});

const metric: MetricDescriptor = {
  id: 'fixture.count/v1', label: 'Count', unit: 'count', scope: 'file', aggregate: 'sum', better: 'lower',
};

const catalogPlugin: Plugin = {
  id: 'catalog', api: pluginApi, version: '1', kinds: ['analysis'], operations: [],
  produces: [{ contract: a.id, persistence: 'transient', metrics: [metric] }],
};

function catalogPlan(...plugins: readonly Plugin[]) {
  return plan({ plugins, select: [], inputs: new Map() });
}

test('rules must reference metrics declared by their own plugin', () => {
  const plugin = { ...catalogPlugin, produces: [],
    rules: [{ id: 'threshold', category: 'structure', measure: metric.id }] };
  assert.throws(() => catalogPlan({ ...catalogPlugin, id: 'other' }, plugin), /rule.*threshold.*undeclared metric.*fixture.count/i);
  assert.doesNotThrow(() => catalogPlan({ ...plugin, produces: catalogPlugin.produces }));
});

test('a ratio must reference declared metrics or standard core counters', () => {
  const ratio: MetricDescriptor = { ...metric, id: 'fixture.ratio/v1', unit: 'ratio',
    ratio: { of: 'repometry.lcov-covered-lines/v1', over: 'fixture.missing/v1' } };
  const plugin = { ...catalogPlugin, produces: [{ contract: a.id, persistence: 'transient' as const, metrics: [metric, ratio] }] };
  assert.throws(() => catalogPlan(plugin), /ratio.*fixture.ratio\/v1.*fixture.missing\/v1/i);
  assert.doesNotThrow(() => catalogPlan({ ...plugin, produces: [{ ...plugin.produces[0]!,
    metrics: [metric, { ...ratio, ratio: { ...ratio.ratio!, over: metric.id } }] }] }));
});

test('metric IDs are unique across products and across plugins', () => {
  const duplicate = { contract: b.id, persistence: 'transient' as const, metrics: [metric] };
  assert.throws(() => catalogPlan({ ...catalogPlugin, produces: [...catalogPlugin.produces, duplicate] }),
    /duplicate metric.*fixture.count.*catalog/i);
  assert.throws(() => catalogPlan(catalogPlugin, { ...catalogPlugin, id: 'competing-plugin' }),
    /duplicate metric.*fixture.count.*catalog.*competing-plugin/i);
});

test('language claims go through claims.languages only', () => {
  const oldShape = { ...catalogPlugin, languages: ['javascript'] };
  assert.throws(() => catalogPlan(oldShape), /claims.languages/);
  assert.doesNotThrow(() => catalogPlan({ ...catalogPlugin, claims: { languages: ['javascript'] } }));
});

test('the planner requires every plugin to declare a manifest', () => {
  const legacy = { id: 'legacy-fixture', api: pluginApi, version: '1', operations: [] };
  const request = { plugins: [legacy as unknown as Plugin], select: [], inputs: new Map() };
  assert.throws(() => plan(request), /missing plugin manifest.*legacy-fixture/i);
  const partial = { ...request, plugins: [{ ...legacy, kinds: ['analysis'] } as unknown as Plugin] };
  assert.throws(() => plan(partial), /must declare its products/i);
});
