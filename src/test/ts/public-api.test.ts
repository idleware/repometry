import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from '@babel/parser';

const entries = {
  'repometry': { declarations: 'index',
    values: [
      'inspect', 'measureDiffCoverage', 'review', 'reviewExitCode'
    ],
    types: [
      'DiffCoveragePorts', 'DiffCoverageRequest', 'DiffCoverageSource',
      'FindingIgnoreRule', 'FindingInput', 'InspectRequest', 'ReviewOptions', 'ReviewRequest'
    ],
  },
  'repometry/plugin': { declarations: 'plugin',
    values: [
      'DockerToolRunner', 'LocalOperationCache', 'codeStructure', 'codeStructures', 'execute', 'findingResult',
      'measurements', 'plan', 'pluginApi', 'processPlugin', 'processPluginProtocol', 'sourceFile', 'sourceFiles'
    ],
    types: [
      'Candidate', 'CloneSource', 'CodeStructure', 'DataContract', 'DockerToolLimits', 'FileClaims', 'Finding',
      'FindingLocation', 'FindingResult', 'FunctionComplexity', 'InputBinding', 'InspectionInputs',
      'InventoryFile', 'LanguageDisplay', 'Measurement', 'MetricDescriptor', 'MetricScope', 'Operation',
      'OperationCache', 'OperationCacheOptions', 'Outcome', 'PlanRequest', 'PlannedOperation', 'Plugin',
      'PluginConfigSchema', 'PluginKind', 'ProcessOperation', 'ProcessPluginManifest', 'Product',
      'ProductDeclaration', 'ProvidedLanguage', 'RuleDescriptor', 'SourceContext', 'SourceFile', 'SourcePlugin',
      'SourceProvider', 'SourceSnapshot', 'StructuralCheck', 'StructuralObservation', 'StructureMeasure',
      'ToolInvocation', 'ToolResult', 'ToolRunner'
    ],
  },
  'repometry/report': { declarations: 'report',
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
  for (const [entry, { declarations, values, types }] of Object.entries(entries)) {
    const api = await import(entry) as Record<string, unknown>;
    assert.deepEqual(Object.keys(api).sort(), [...values], entry);
    const source = await readFile(`target/main/ts/${declarations}.d.ts`, 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: [['typescript', { dts: true }]] });
    const names = ast.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' ? node.specifiers.map(specifier => {
      const name = specifier.exported;
      return name.type === 'Identifier' ? name.name : name.value;
    }) : []);
    assert.deepEqual(names.sort(), [...values, ...types].sort(), entry);
    allNames.push(...names);
  }
  assert.equal(new Set(allNames).size, allNames.length);
  await assert.rejects(import('repometry/' + 'core/engine/plan'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
