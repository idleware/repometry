import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileSettings } from '../../main/ts/report/json/projections/inspection-details.js';
import { badges } from '../../main/ts/report/html/site/badges.js';

test('the applied profile is projected field by field, and malformed parts are left out', () => {
  const profile = profileSettings({
    profile: 'js-ts/v2',
    source: { extensions: ['.ts', 7], excludedDirectories: ['node_modules'], excludedPaths: ['.yarn/releases'] },
    maintainability: {
      structuralRules: { 'function-complexity': { limit: 15, minutesPerExcess: 10 }, broken: { limit: 'x' } },
      duplication: { minCodeLines: 12, minNodes: 50, minutesPerRepeatedLine: 2 },
      debtModel: { name: 'basic-cocomo-organic', scale: 2.4, exponent: 1.05, minutesPerPersonMonth: 9600 },
    },
    churn: { lookbackDays: 90, maxCommits: 512 },
    findingIgnore: [{ tool: 'repometry', rule: 'identical-code', path: 'a.ts', extra: 1 }],
    plugins: [{ id: 'structure', version: '1.0.0', tools: { '@babel/types': '7.29.15' } }, { id: 7 }],
  });
  assert.equal(profile?.id, 'js-ts/v2');
  assert.deepEqual(profile?.extensions, ['.ts']);
  assert.deepEqual(profile?.rules, [{ plugin: 'maintainability', rule: 'function-complexity', limit: 15, minutesPerExcess: 10 }]);
  assert.deepEqual(profile?.ignore, [{ tool: 'repometry', rule: 'identical-code', path: 'a.ts' }]);
  assert.deepEqual(profile?.analyzers, [{ id: 'structure', version: '1.0.0', tools: { '@babel/types': '7.29.15' } }]);
  assert.equal(profile?.churn?.lookbackDays, 90);
  assert.equal(profileSettings(null), undefined);
});

test('a security badge is made only when scanner counts are given, naming the worst level as one letter', () => {
  assert.equal(badges(undefined, undefined).has('security.svg'), false);
  const clear = badges(undefined, undefined, { high: 0, medium: 0, low: 0, unknown: 0 }).get('security.svg')!.toString();
  assert.match(clear, /security: N/);
  const high = badges(undefined, undefined, { high: 2, medium: 5, low: 1, unknown: 0 }).get('security.svg')!.toString();
  assert.match(high, /security: H/);
  assert.match(high, /#ec8a2c/);
  const critical = badges(undefined, undefined, { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 }).get('security.svg')!.toString();
  assert.match(critical, /security: C/);
  assert.match(critical, /#db4a3f/);
  assert.match(badges(undefined, undefined).get('coverage.svg')!.toString(), /coverage: —/);
});
