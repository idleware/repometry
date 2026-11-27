import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeInspection } from '../../main/ts/usecases/inspect.js';
import { reportSchema } from '../../main/ts/model/report.js';
import type { Report } from '../../main/ts/model/report.js';
import type { SourceSnapshot } from '../../main/ts/model/source.js';

const snapshot: SourceSnapshot = { subject: { kind: 'working-tree', id: 'a'.repeat(64) }, files: [] };
const report: Report = {
  schema: reportSchema, subject: snapshot.subject, generatedAt: '2026-11-20T00:00:00.000Z',
  appliedConfig: { profile: 'fixture' }, definitions: {}, scope: { files: 0, parsed: 0 },
  status: 'not-applicable', measurements: [], diagnostics: [],
};

test('inspection uses the injected snapshot and writes only a report for that snapshot', async () => {
  const saved: Report[] = [];
  const readSource = async (excludes: (path: string) => boolean) => {
    assert.ok(excludes('vendor/tool.js'));
    return { snapshot, root: '/fixture', excludedOutput: '.repometry', save: async (result: Report) => { saved.push(result); } };
  };
  const analyzed = { ...report, appliedConfig: { source: { excludedPaths: ['vendor/**'] } } };
  const valid = await executeInspection({ exclude: ['vendor/**'] }, {
    readSource,
    analyze: async input => {
      assert.equal(input.snapshot, snapshot);
      assert.equal(input.excludedOutput, '.repometry');
      return analyzed;
    },
  });
  assert.deepEqual(saved, [valid]);
  await assert.rejects(executeInspection({ exclude: ['vendor/**'] }, {
    readSource,
    analyze: async () => ({ ...analyzed, subject: { kind: 'working-tree', id: 'b'.repeat(64) } }),
  }), /different source snapshot/);
  assert.deepEqual(saved, [valid]);
});
