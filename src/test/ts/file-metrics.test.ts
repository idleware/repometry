import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import metricCatalog from '../../main/resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import fileSchema from '../../main/resources/report/json/file-metrics-v1.schema.json' with { type: 'json' };
import reportSchema from '../../main/resources/report/json/report-v2.schema.json' with { type: 'json' };
import { definitions } from '../../main/ts/core/model/measurement.js';
import { fileMetrics, fileMetricsSchema } from '../../main/ts/report/json/projections/file-metrics.js';
import type { Report } from '../../main/ts/report/json/validation/report.js';

test('file metrics roll up known counts and distinguish uncovered from missing files', () => {
  const report: Report = {
    schema: 'urn:repometry:schema:report:2',
    subject: { kind: 'commit', id: 'a'.repeat(40) },
    generatedAt: '2026-11-21T00:00:00Z',
    status: 'partial',
    scope: { files: 4, parsed: 3 },
    appliedConfig: { profile: 'js-ts/v1' },
    definitions: {},
    measurements: [
      { definition: definitions.lines, target: 'file', path: 'src/app.js', value: 100 },
      { definition: definitions.functions, target: 'file', path: 'src/app.js', value: 2 },
      { definition: definitions.complexity, target: 'function', path: 'src/app.js', value: 7 },
      { definition: definitions.complexity, target: 'function', path: 'src/app.js', value: 4 },
      { definition: definitions.coverage, target: 'file', path: 'src/app.js', value: 67 / 70, covered: 67, total: 70 },
      { definition: definitions.lines, target: 'file', path: 'src/nested/b.js', value: 20 },
      { definition: definitions.functions, target: 'file', path: 'src/nested/b.js', value: 0 },
      { definition: definitions.coverage, target: 'file', path: 'src/nested/b.js', value: 0, covered: 0, total: 5 },
      { definition: definitions.lines, target: 'file', path: 'src/c.js', value: 30 },
      { definition: definitions.functions, target: 'file', path: 'src/c.js', value: 1 },
      { definition: definitions.complexity, target: 'function', path: 'src/c.js', value: 5 },
    ],
    diagnostics: [
      { operation: 'babel-syntax/parse', state: 'failed', message: 'Cannot parse', path: 'src/bad.js' },
      { operation: 'lcov/import', state: 'partial', message: 'Unmapped source', path: 'out/generated.js' },
    ],
  };
  const output = fileMetrics(report);
  const validate = new Ajv2020({ schemas: [metricCatalog] }).addSchema(reportSchema).compile(fileSchema);
  assert.ok(validate(output), JSON.stringify(validate.errors));
  assert.equal(output.schema, fileMetricsSchema);
  assert.deepEqual(output.directories[0], {
    path: '', files: 4, sizeMeasuredFiles: 3, coverageMeasuredFiles: 2,
    lines: 150, functions: 3, lineCoverage: { covered: 67, total: 75 },
    complexity: { sum: 16, maximum: 7, measuredFunctions: 3 }, diagnosticCount: 1,
  });
  assert.deepEqual(output.files.find(file => file.path === 'src/bad.js'), {
    path: 'src/bad.js', lines: null, functions: null, complexity: null, lineCoverage: null, diagnosticCount: 1, language: 0,
  });
  assert.equal(output.files.find(file => file.path === 'src/c.js')?.lineCoverage, null);
  assert.deepEqual(output.files.find(file => file.path === 'src/nested/b.js')?.lineCoverage, { covered: 0, total: 5 });
  assert.equal(output.unassignedDiagnostics, 1);
  assert.deepEqual(output.hotspots, { complexity: ['src/app.js', 'src/c.js'], missedLines: ['src/nested/b.js', 'src/app.js'] });
});

test('file quality totals use measured denominators and preserve unknown effort', () => {
  const report: Report = {
    schema: 'urn:repometry:schema:report:2',
    subject: { kind: 'commit', id: 'b'.repeat(40) },
    generatedAt: '2026-11-21T00:00:00Z',
    status: 'partial',
    scope: { files: 3, parsed: 3 },
    appliedConfig: { profile: 'js-ts/v1' },
    definitions: {},
    measurements: [
      { definition: definitions.codeLines, target: 'file', path: 'src/a.js', value: 40 },
      { definition: definitions.codeLines, target: 'file', path: 'src/b.js', value: 10 },
      { definition: definitions.codeLines, target: 'file', path: 'src/c.js', value: 50 },
      { definition: definitions.duplicatedLines, target: 'file', path: 'src/a.js', value: 7 },
      { definition: definitions.duplicatedLines, target: 'file', path: 'src/b.js', value: 0 },
      { definition: definitions.cognitiveComplexity, target: 'file', path: 'src/a.js', value: 1 },
      { definition: definitions.cognitiveComplexity, target: 'file', path: 'src/b.js', value: 5 },
    ],
    diagnostics: [],
    findings: [
      { tool: 'repometry', rule: 'file-complexity', category: 'structure', level: 'medium',
        message: 'File complexity', path: 'src/a.js', effortMinutes: 30 },
      { tool: 'repometry', rule: 'returns', category: 'structure', level: 'medium',
        message: 'Return statements', path: 'src/b.js' },
    ],
  };
  const output = fileMetrics(report);
  const validate = new Ajv2020({ schemas: [metricCatalog] }).addSchema(reportSchema).compile(fileSchema);
  assert.ok(validate(output), JSON.stringify(validate.errors));
  assert.deepEqual(output.directories[0]?.quality, {
    codeLines: 100, cognitiveComplexity: 6, duplication: { duplicatedLines: 7, codeLines: 50 },
    maintainability: { smells: 2, effortMinutes: null },
  });
  assert.deepEqual(output.files[0]?.quality?.maintainability, { smells: 1, effortMinutes: 30 });
  assert.equal(output.files[2]?.quality?.duplication, undefined);
  assert.deepEqual(output.hotspots.cognitive, ['src/b.js', 'src/a.js']);
  assert.deepEqual(output.hotspots.duplication, ['src/a.js']);
});
