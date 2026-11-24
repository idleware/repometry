import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileSettings } from '../../main/ts/report/json/projections/inspection-details.js';
import { badges } from '../../main/ts/report/html/site/badges.js';
import type { PublicHistoryEntry } from '../../main/ts/report/json/wire/public-history-model.js';

test('the applied profile is projected field by field, and malformed parts are left out', () => {
  const profile = profileSettings({
    profile: 'js-ts/v2',
    source: { extensions: ['.ts', '.js', '.mts', '.py', '.ts', 7], excludedDirectories: ['node_modules'], excludedPaths: ['.yarn/releases'] },
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
  assert.deepEqual(profile?.languages, [
    { plugin: 'babel-syntax', id: 'javascript', label: 'JavaScript', extensions: ['.js'], globs: [] },
    { plugin: 'babel-syntax', id: 'typescript', label: 'TypeScript', extensions: ['.ts', '.mts'], globs: [] },
  ]);
  assert.ok(profile && !Object.hasOwn(profile, 'extensions'));
  assert.deepEqual(profile?.rules, [{ plugin: 'maintainability', rule: 'function-complexity', limit: 15, minutesPerExcess: 10 }]);
  assert.deepEqual(profile?.ignore, [{ tool: 'repometry', rule: 'identical-code', path: 'a.ts' }]);
  assert.deepEqual(profile?.analyzers, [{ id: 'structure', version: '1.0.0', tools: { '@babel/types': '7.29.15' } }]);
  assert.equal(profile?.churn?.lookbackDays, 90);
  assert.equal(profileSettings(null), undefined);
});

test('a security badge is made only when scanner counts are given, grading the worst finding A to F', () => {
  assert.equal(badges(undefined, undefined).has('security.svg'), false);
  const clear = badges(undefined, undefined, { high: 0, medium: 0, low: 0, unknown: 0 }).get('security.svg')!.toString();
  assert.match(clear, /security: A/);
  const high = badges(undefined, undefined, { high: 2, medium: 5, low: 1, unknown: 0 }).get('security.svg')!.toString();
  assert.match(high, /security: D/);
  assert.match(high, /#ec8a2c/);
  const critical = badges(undefined, undefined, { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 }).get('security.svg')!.toString();
  assert.match(critical, /security: F/);
  assert.match(critical, /#db4a3f/);
  const low = badges(undefined, undefined, { high: 0, medium: 0, low: 0, unknown: 3 }).get('security.svg')!.toString();
  assert.match(low, /security: B/);
  const medium = badges(undefined, undefined, { high: 0, medium: 1, low: 4, unknown: 0 }).get('security.svg')!.toString();
  assert.match(medium, /security: C/);
  assert.match(badges(undefined, undefined).get('coverage.svg')!.toString(), /coverage: —/);
});

test('flat coverage badges floor the displayed percentage and keep their grade colour', () => {
  const svg = (covered: number, total: number) => badges({ lineCoverage: { covered, total } } as PublicHistoryEntry,
    undefined).get('coverage.svg')!.toString();
  assert.match(svg(657, 1000), /aria-label="coverage: 65%"/);
  assert.match(svg(29, 100), /aria-label="coverage: 29%"/);
  assert.match(svg(996, 1000), /fill="#5ec269"/);
  assert.match(svg(1, 100), /fill="#db4a3f"/);
  const fullCoverage = svg(100, 100);
  assert.match(fullCoverage, /height="20"[^>]*role="img" aria-label="coverage: 100%"/);
  assert.match(fullCoverage, /<text x="7"[^>]*font-weight="400"[^>]*>coverage<\/text>/);
  assert.match(fullCoverage, /font-weight="700" textLength="30"[^>]*>100%<\/text>/);
  assert.doesNotMatch(fullCoverage, /<path\b/);
  assert.equal(fullCoverage.match(/lengthAdjust="spacingAndGlyphs"/g)?.length, 2);
});

test('the three badges can be inlined together without sharing SVG IDs', () => {
  const files = badges(undefined, undefined, { high: 0, medium: 0, low: 0, unknown: 0 });
  const ids: string[] = [];
  for (const bytes of files.values()) {
    const svg = bytes.toString();
    const localIds = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
    const references = [...new Set([...svg.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]!))];
    assert.deepEqual(references.sort(), localIds.toSorted());
    ids.push(...localIds);
  }
  assert.equal(new Set(ids).size, 9);
});
