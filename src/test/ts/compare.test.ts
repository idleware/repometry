import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import comparisonV1 from '../../main/resources/report/json/comparison-v1.schema.json' with { type: 'json' };
import metricCatalog from '../../main/resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import reportV2 from '../../main/resources/report/json/report-v2.schema.json' with { type: 'json' };
import { analyzeSnapshot } from '../../main/ts/compose/inspect.js';
import { compareInspections, comparisonSchema } from '../../main/ts/core/usecases/compare.js';
import type { InspectionComparison } from '../../main/ts/core/usecases/compare.js';
import { inspectionProfileDigest } from '../../main/ts/report/json/projections/inspection-context.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';

const cli = resolve('target/main/ts/cli/main.js');
const validator = new Ajv2020({ schemas: [metricCatalog, reportV2] }).compile<InspectionComparison>(comparisonV1);
const first = 'a'.repeat(40);
const head = 'b'.repeat(40);
const beforeSource = 'export function f() {\n  return 1;\n}\n';
const afterSource = 'export function f(flag: boolean) {\n  return flag ? 1 : 0;\n}\nexport function g() {}\n';

test('compare reads two saved reports and withholds the delta after an exclusion change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-compare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseOutput = join(dir, 'base');
  const headOutput = join(dir, 'head');
  const baseStore = new LocalReportStore(baseOutput);
  const headStore = new LocalReportStore(headOutput);
  await baseStore.save(await analyze(first, beforeSource, 0));
  await headStore.save(await analyze(head, afterSource, 1));

  const args = ['compare', first, head, '--store', headOutput, '--baseline-store', baseOutput];
  const run = () => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  const proper = run();
  assert.equal(proper.status, 0, proper.stderr);
  const result = JSON.parse(proper.stdout) as InspectionComparison;
  assert.ok(validator(result), JSON.stringify(validator.errors));
  assert.equal(result.schema, comparisonSchema);
  assert.deepEqual(result.baseline.subject, { kind: 'commit', id: first });
  assert.deepEqual(result.current.subject, { kind: 'commit', id: head });
  assert.equal(result.metrics.physicalLines.delta, 1);
  assert.equal(result.metrics.functions.delta, 1);
  assert.equal(result.metrics.maxCyclomaticComplexity.delta, 1);
  assert.equal(result.metrics.lineCoverage.delta, 50);
  assert.deepEqual(result.metrics.lineCoverage.baseline, { status: 'complete', covered: 1, total: 2, value: 50 });

  await headStore.save(await analyze(head, afterSource, 1, { exclude: ['vendor'] }));
  const changed = run();
  assert.equal(changed.status, 0, changed.stderr);
  const comparison = JSON.parse(changed.stdout) as InspectionComparison;
  assert.ok(validator(comparison), JSON.stringify(validator.errors));
  assert.equal(comparison.metrics.maxCyclomaticComplexity.baseline.value, 1);
  assert.equal(comparison.metrics.maxCyclomaticComplexity.current.value, 2);
  assert.equal(comparison.metrics.maxCyclomaticComplexity.status, 'incompatible');
  assert.equal(comparison.metrics.maxCyclomaticComplexity.reason, 'source-scope-changed');
  assert.equal(comparison.metrics.maxCyclomaticComplexity.delta, null);
});

test('comparison uses completeness and methodology for the relevant measurement', async () => {
  const baseline = await analyze(first, beforeSource, 0);
  const partial = await analyze(head, afterSource, 1, { missingCoverageFile: true });
  const normal = await analyze(head, afterSource, 1);
  const withGap = compareInspections(baseline, partial).metrics;
  assert.equal(withGap.physicalLines.delta, 1);
  assert.equal(withGap.lineCoverage.current.status, 'partial');
  assert.equal(withGap.lineCoverage.current.value, 100);
  assert.equal(withGap.lineCoverage.status, 'unavailable');
  assert.equal(withGap.lineCoverage.delta, null);

  const methodChange = compareInspections(baseline, { ...normal,
    appliedConfig: { ...normal.appliedConfig, parser: { sourceType: 'script' } } }).metrics;
  assert.equal(methodChange.maxCyclomaticComplexity.reason, 'method-changed');
  assert.equal(methodChange.maxCyclomaticComplexity.delta, null);
  assert.equal(methodChange.lineCoverage.delta, 50);
});

test('provider-owned tool provenance compares with earlier reports without a profile boundary', async () => {
  const current = await analyze(head, afterSource, 1);
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
  const historical = { ...current, appliedConfig: { ...current.appliedConfig, plugins } };
  assert.equal(inspectionProfileDigest(historical), inspectionProfileDigest(current));
  const comparison = compareInspections(historical, current);
  assert.equal(comparison.metrics.physicalLines.delta, 0);
  assert.equal(comparison.metrics.functions.delta, 0);
  assert.equal(comparison.metrics.maxCyclomaticComplexity.delta, 0);
});

function analyze(id: string, source: string, hits: number,
  options: { exclude?: readonly string[]; missingCoverageFile?: true } = {}) {
  const gap = options.missingCoverageFile ? 'SF:absent.ts\nDA:1,1\nend_of_record\n' : '';
  return analyzeSnapshot({
    snapshot: { subject: { kind: 'commit', id }, files: [{ path: 'src/main.ts', bytes: Buffer.from(source) }] },
    excludedOutput: null,
    excludedPaths: options.exclude,
    coverage: { sourceRoot: '/project', text: `SF:src/main.ts\nDA:1,${hits}\nDA:2,1\nend_of_record\n${gap}` },
  });
}
