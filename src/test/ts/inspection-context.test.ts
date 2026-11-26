import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { inspectionContext } from '../../main/ts/report/json/projections/inspection-context.js';
import { siteSummary } from '../../main/ts/report/html/site/export-site.js';
import { commitSummary } from '../../main/ts/report/json/projections/commit-summary.js';
import type { RepositorySummary } from '../../main/ts/report/json/wire/summary-model.js';
import { reportSchema } from '../../main/ts/report/json/validation/report.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';

const source = { extensions: ['.js', '.ts'], excludedDirectories: ['.git', 'node_modules'], excludedOutput: null };
const profile = { profile: 'js-ts/v1', source, coverage: null };

test('local history identifies profile boundaries and reads exclusions in legacy reports', () => {
  const original = report('a', profile);
  const filtered = report('b', { ...profile, source: { ...source, excludedPaths: ['.yarn/releases'] } });
  const upgraded = report('c', { ...filtered.appliedConfig, plugins: [{ id: 'structure', version: '2.0.0' }] });
  const unknown = report('d', { profile: 'unknown' });
  assert.deepEqual(inspectionContext(original), { exclusions: { paths: [], directories: ['.git', 'node_modules'] }, boundary: null });
  assert.deepEqual(inspectionContext(filtered), { exclusions: { paths: ['.yarn/releases'], directories: ['.git', 'node_modules'] }, boundary: null });
  assert.deepEqual(inspectionContext(unknown), { exclusions: null, boundary: null });
  assert.deepEqual(boundaries(unknown, upgraded, filtered, original), ['unavailable', 'changed', 'changed', undefined]);
});

test('equivalent exclusions and changing LCOV inputs preserve profile comparability', () => {
  const rules = ['.yarn/releases', '**/vendor'];
  const old = report('a', { ...profile, source: { ...source, excludedPaths: rules },
    coverage: { merge: 'any-hit', inputDigest: 'old', pathBase: '/repo-old' } });
  const recent = report('b', { ...profile, source: { ...source, excludedPaths: [rules[1], ...rules] },
    coverage: { merge: 'any-hit', inputDigest: 'new', pathBase: '/repo-new' } });
  const legacy = report('c', profile);
  const modern = report('d', { ...profile, source: { ...source, excludedPaths: [] } });
  assert.deepEqual(boundaries(recent, old), [undefined, undefined]);
  assert.deepEqual(boundaries(modern, legacy), [undefined, undefined]);
});

test('the timeline marks a profile change without publishing its rules or digest', () => {
  const original = report('b', profile);
  const filtered = report('a', { ...profile, source: { ...source, excludedPaths: ['.yarn/releases'] } });
  const rows = [original, filtered].map(commitSummary);
  const text = siteSummary(rows, {}).toString();
  const index = JSON.parse(text) as RepositorySummary;
  assert.deepEqual(index.commits.map(row => row.profileBoundary), ['changed', undefined]);
  assert.doesNotMatch(text, /profileDigest|\.yarn\/releases/);
});

test('legacy placement of Babel tools does not create a profile boundary', async () => {
  const current = await analyzeSnapshot({ excludedOutput: null, snapshot: {
    subject: { kind: 'commit', id: 'b'.repeat(40) },
    files: [{ path: 'src/main.ts', bytes: Buffer.from('export function f(flag: boolean) { return flag ? 1 : 0; }\n') }],
  } });
  const entries = current.appliedConfig.plugins;
  assert.ok(Array.isArray(entries));
  const syntax = entries.find(entry => entry.id === 'babel-syntax');
  const { '@babel/types': version, ...parserTools } = syntax.tools;
  assert.equal(typeof version, 'string');
  const plugins = entries.map(entry => {
    if (entry === syntax) return { ...entry, tools: parserTools };
    if (entry.id === 'structure' || entry.id === 'maintainability') {
      return { ...entry, tools: { ...entry.tools, '@babel/types': version } };
    }
    return entry;
  });
  const historical: Report = { ...current, subject: { kind: 'commit', id: 'a'.repeat(40) },
    appliedConfig: { ...current.appliedConfig, plugins } };
  assert.deepEqual(boundaries(current, historical), [undefined, undefined]);
});

function boundaries(...reports: Report[]) {
  const index = JSON.parse(siteSummary(reports.map(commitSummary), {}).toString()) as RepositorySummary;
  return index.commits.map(row => row.profileBoundary);
}

function report(key: string, appliedConfig: Report['appliedConfig']): Report {
  return { schema: reportSchema, subject: { kind: 'commit', id: key.repeat(40) },
    generatedAt: `2026-11-${20 + key.charCodeAt(0) - 97}T00:00:00.000Z`, status: 'complete', scope: { files: 1, parsed: 1 },
    appliedConfig, definitions: {}, diagnostics: [], measurements: [] };
}
