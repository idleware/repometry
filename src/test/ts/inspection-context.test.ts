import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectionHistory } from '../../main/ts/report/json/projections/inspection-context.js';
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
  const local = inspectionHistory([unknown, upgraded, filtered, original]);
  assert.deepEqual(local[original.subject.id], { exclusions: { paths: [], directories: ['.git', 'node_modules'] }, boundary: null });
  assert.deepEqual(local[filtered.subject.id], { exclusions: { paths: ['.yarn/releases'], directories: ['.git', 'node_modules'] }, boundary: 'changed' });
  assert.equal(local[upgraded.subject.id]?.boundary, 'changed');
  assert.deepEqual(local[unknown.subject.id], { exclusions: null, boundary: 'unavailable' });
});

test('equivalent exclusions and changing LCOV inputs preserve profile comparability', () => {
  const rules = ['.yarn/releases', '**/vendor'];
  const old = report('a', { ...profile, source: { ...source, excludedPaths: rules },
    coverage: { merge: 'any-hit', inputDigest: 'old', pathBase: '/repo-old' } });
  const recent = report('b', { ...profile, source: { ...source, excludedPaths: [rules[1], ...rules] },
    coverage: { merge: 'any-hit', inputDigest: 'new', pathBase: '/repo-new' } });
  const legacy = report('c', profile);
  const modern = report('d', { ...profile, source: { ...source, excludedPaths: [] } });
  assert.equal(inspectionHistory([recent, old])[recent.subject.id]?.boundary, null);
  assert.equal(inspectionHistory([modern, legacy])[modern.subject.id]?.boundary, null);
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

function report(key: string, appliedConfig: Report['appliedConfig']): Report {
  return { schema: reportSchema, subject: { kind: 'commit', id: key.repeat(40) },
    generatedAt: '2026-11-21T00:00:00.000Z', status: 'complete', scope: { files: 1, parsed: 1 },
    appliedConfig, definitions: {}, diagnostics: [], measurements: [] };
}
