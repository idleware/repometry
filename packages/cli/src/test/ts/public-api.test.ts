import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from '@babel/parser';

const entries = {
  'repometry': {
    values: [
      'inspect', 'measureDiffCoverage', 'review', 'reviewExitCode'
    ],
    types: [
      'DiffCoveragePorts', 'DiffCoverageRequest', 'DiffCoverageSource',
      'FindingInput', 'IgnoreEntry', 'InspectRequest', 'ReviewOptions', 'ReviewRequest'
    ],
  },
  'repometry/plugin': {
    values: ['codeStructure', 'codeStructures', 'findingResult', 'measurements', 'pluginManifestSchema', 'sourceFile', 'sourceFiles'],
    types: ['Candidate', 'Check', 'CloneSource', 'CodeStructure', 'DataContract', 'Finding', 'FindingLocation', 'FindingResult',
      'FunctionComplexity', 'InspectionInputs', 'LanguageDisplay', 'LanguageSyntax', 'Measurement', 'MetricDescriptor', 'MetricScope',
      'Operation', 'PluginCategory', 'PluginManifest', 'ProductOutput', 'SourceFile', 'StructuralCheck', 'StructuralObservation'],
  },
  'repometry/report': {
    values: [
      'GitReportReader', 'LocalReportStore', 'coverageGrade', 'diffCoverageSchema',
      'fileMetrics', 'fileMetricsSchema', 'pullReviewSchema', 'pullReviewsSchema', 'qualitySummary',
      'readReport', 'reportSchema', 'summarySchema', 'validateSummary'
    ],
    types: [
      'CommitSummary', 'Diagnostic', 'DiffCoverageReport', 'FileMetricsReport', 'Grade', 'IgnoredFinding',
      'IssueEffect', 'PublicHistoryEntry', 'PullReview', 'PullReviews', 'QualitySummary',
      'Report', 'ReportReader', 'ReportStore', 'ReportWriter', 'RepositorySummary', 'ReviewReason',
      'ReviewedIssue', 'SourceLocator', 'Subject'
    ],
  },
} as const;

test('package entry points expose each public value and type from one entry point', async () => {
  const allNames: string[] = [];
  for (const [entry, { values, types }] of Object.entries(entries)) {
    const api = await import(entry) as Record<string, unknown>;
    assert.deepEqual(Object.keys(api).sort(), [...values], entry);
    const source = await readFile(new URL(import.meta.resolve(entry).replace(/\.js$/, '.d.ts')), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: [['typescript', { dts: true }]] });
    const names = exportedNames(ast);
    assert.deepEqual(names.sort(), [...values, ...types].sort(), entry);
    allNames.push(...names);
  }
  assert.equal(new Set(allNames).size, allNames.length);
  await assert.rejects(import('repometry/' + 'core/engine/plan'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('the slim and default library entry points have the same names', async () => {
  for (const [entry, { values, types }] of Object.entries(entries)) {
    const slim = entry.replace(/^repometry/, '@repometry/cli');
    const api = await import(slim) as Record<string, unknown>;
    assert.deepEqual(Object.keys(api).sort(), [...values], slim);
    const source = await readFile(new URL(import.meta.resolve(slim).replace(/\.js$/, '.d.ts')), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: [['typescript', { dts: true }]] });
    assert.deepEqual(exportedNames(ast).sort(), [...values, ...types].sort(), slim);
  }
});

test('the core author entry point and CLI plugin entry point expose the same declarations', async () => {
  const entry = entries['repometry/plugin'];
  const core = await import('@repometry/core');
  assert.deepEqual(Object.keys(core).sort(), [...entry.values]);
  const source = await readFile(new URL(import.meta.resolve('@repometry/core').replace(/\.js$/, '.d.ts')), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: [['typescript', { dts: true }]] });
  assert.deepEqual(exportedNames(ast).sort(), [...entry.values, ...entry.types].sort());
});

function exportedNames(ast: ReturnType<typeof parse>): string[] {
  return ast.program.body.flatMap(node => {
    if (node.type !== 'ExportNamedDeclaration') return [];
    const declaration = node.declaration;
    if (declaration && 'id' in declaration && declaration.id?.type === 'Identifier') return [declaration.id.name];
    return node.specifiers.map(specifier => {
      const name = specifier.exported;
      return name.type === 'Identifier' ? name.name : name.value;
    });
  });
}
