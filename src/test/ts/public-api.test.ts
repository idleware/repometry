import assert from 'node:assert/strict';
import { test } from 'node:test';

const entries: Readonly<Record<string, readonly string[]>> = {
  repometry: [
    'GitReportReader', 'LocalReportStore', 'analyzeSnapshot', 'compare', 'compareInspections', 'comparisonSchema',
    'coverageGrade', 'diffCoverage', 'diffCoverageSchema', 'execute', 'fileMetrics', 'fileMetricsSchema', 'inspect',
    'measureDiffCoverage', 'plan', 'pluginApi', 'pullReviewSchema', 'pullReviewsSchema', 'qualitySummary', 'readReport',
    'reportSchema', 'review', 'reviewExitCode', 'reviewPull',
  ],
  'repometry/plugin': ['codeStructure', 'findingResult', 'measurements', 'pluginApi', 'sourceFile'],
  'repometry/report': ['fileMetricsSchema', 'historySchema', 'legacyReportSchema', 'readReport', 'reportSchema', 'summarySchema', 'validateSummary'],
};

test('package entry points expose the stable API and compatibility names', async () => {
  for (const [entry, names] of Object.entries(entries)) {
    const api = await import(entry) as Record<string, unknown>;
    assert.deepEqual(Object.keys(api).sort(), [...names].sort(), entry);
  }
  const root = await import('repometry');
  assert.equal(root.compare, root.compareInspections);
  assert.equal(root.diffCoverage, root.measureDiffCoverage);
  await assert.rejects(import('repometry/' + 'core/engine/plan'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
