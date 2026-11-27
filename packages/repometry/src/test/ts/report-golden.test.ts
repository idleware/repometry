import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import type { ObjectSource } from '../../main/ts/report/json/store/report-tree.js';
import { readStoredReport, reportSchema } from '../../main/ts/report/json/validation/report.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';
import { packJson } from '../../main/ts/report/json/wire/compact-json.js';

const site = await import(new URL('../../../main/ts/report/html/site/export-site.js', import.meta.url).href) as
  typeof import('../../main/ts/report/html/site/export-site.js');

const sha = '4'.repeat(40);
const report: Report = {
  schema: reportSchema,
  subject: { kind: 'commit', id: sha },
  generatedAt: '2026-11-20T00:00:00.000Z',
  committedAt: '2026-11-19T00:00:00.000Z',
  appliedConfig: { profile: 'fixture', source: { excludedPaths: ['vendor/**'], excludedDirectories: ['node_modules'] } },
  definitions: { [definitions.lines]: 'Physical lines', [definitions.coverage]: 'Line coverage' },
  status: 'complete',
  scope: { files: 1, parsed: 1 },
  measurements: [
    { definition: definitions.lines, target: 'file', path: 'src/example.js', value: 8 },
    { definition: definitions.coverage, target: 'repository', value: 0.75, covered: 3, total: 4 },
  ],
  diagnostics: [],
};

test('the report formats and export projections match the fixed baseline', async () => {
  const { committedAt, ...legacyFields } = report;
  const old = { ...legacyFields, schema: 'urn:repometry:schema:report:1' };
  const singleFile: ObjectSource = { read: () => Promise.reject(new Error('A single-file report reads no objects')) };
  await assert.rejects(readStoredReport(JSON.stringify(old), report.subject, singleFile), /Unsupported or missing report schema/);
  assert.deepEqual(await readStoredReport(JSON.stringify(packJson(report)), report.subject, singleFile), report);

  const actual: Record<string, string> = {};
  for (const mode of ['private'] as const) {
    const files = await site.siteFiles([report], { title: 'Fixture' });
    assert.equal(files.has('history.json') || files.has('quality-history.json'), false);
    for (const [name, bytes] of files) {
      if (name.endsWith('.json') || name.endsWith('.svg')) {
        actual[mode + '/' + name] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  const baseline: unknown = JSON.parse(readFileSync('src/test/resources/architecture/report-golden.json', 'utf8'));
  assert.deepEqual(actual, baseline);
});
