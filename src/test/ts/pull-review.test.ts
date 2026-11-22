import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffCoverageSchema } from '../../main/ts/compose/diff-coverage.js';
import type { DiffCoverageReport } from '../../main/ts/compose/diff-coverage.js';
import { analyzeSnapshot } from '../../main/ts/compose/inspect.js';
import { projectReview, reviewExitCode } from '../../main/ts/compose/review.js';
import type { Finding } from '../../main/ts/core/model/finding.js';
import { listPullReviews, savePullReview } from '../../main/ts/report/json/store/pull-review-store.js';
import { digest } from '../../main/ts/core/model/snapshot.js';

const baseId = 'a'.repeat(40);
const headId = 'b'.repeat(40);
const path = 'src/code,with%.ts';
const normal: Finding = { tool: 'structure', rule: 'return-statements', category: 'structure', level: 'medium',
  message: 'Function has too many returns', path, line: 1 };
const sensitive: Finding = { tool: 'secret-scan', rule: 'private', category: 'secret', level: 'high',
  message: '<private finding>', path, line: 2 };

test('review keeps a private result and gates comparable data only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repometry-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { ...await inspection(baseId, 1), findings: [normal] };
  const head = { ...await inspection(headId, 0), findings: [{ ...normal, line: 3 }, sensitive] };
  const observed: DiffCoverageReport = {
    schema: diffCoverageSchema, requestedBase: baseId, base: baseId, head: headId, generatedAt: '2026-11-20T00:00:00.000Z',
    appliedConfig: { lcov: { inputDigest: digest(lcov(0)) } }, covered: 0, total: 1, percent: 0,
    status: 'complete', files: [{ path, addedLines: 1, covered: 0, total: 1 }], gaps: [],
    decision: { status: 'failed', minimumPercent: 90 },
  };
  const skipped = projectReview({ number: 19, minimumLines: 3, maxCoverageDrop: 50, maxNewIssues: 0 },
    observed, [{ path, lines: [2] }], head, base);
  assert.equal(skipped.coverage.delta, -50);
  assert.equal(skipped.coverage.gate?.status, 'passed');
  assert.equal(skipped.diff.gate?.status, 'not-applicable');
  assert.deepEqual(skipped.findings.added, [sensitive]);
  assert.equal(skipped.findings.gate?.status, 'passed');
  assert.equal(reviewExitCode(skipped), 0);

  await savePullReview(dir, skipped);
  assert.deepEqual(await listPullReviews(dir), [skipped]);
  const failed = projectReview({ number: 19, maxCoverageDrop: 1 }, observed, [{ path, lines: [2] }], head, base);
  assert.equal(reviewExitCode(failed), 3);
  await savePullReview(dir, failed);
  assert.deepEqual(await listPullReviews(dir), [failed]);

  const partial = projectReview({ maxCoverageDrop: 1 }, observed, [], head, null);
  assert.equal(partial.coverage.gate?.status, 'indeterminate');
  assert.equal(reviewExitCode(partial), 2);

  const client = new URL('../../main/ts/api/gh/github.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { readFile } from 'node:fs/promises';
     import { writeGitHubReview } from ${JSON.stringify(client)};
     await writeGitHubReview(JSON.parse(await readFile(process.argv[1], 'utf8')), process.cwd());`,
    join(dir, 'reviews/19.json')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: join(dir, 'outputs'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_WORKSPACE: dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /::warning file=src\/code%2Cwith%25\.ts,line=2,/);
  const output = await readFile(join(dir, 'outputs'), 'utf8');
  const summary = await readFile(join(dir, 'summary'), 'utf8');
  assert.match(output, /^new-issues=0$/m);
  assert.match(summary, /Changed files/);
  assert.doesNotMatch(summary, /private finding|secret-scan/);
});

function lcov(hits: number): string {
  return `SF:${path}\nDA:1,1\nDA:2,${hits}\nend_of_record\n`;
}

function inspection(id: string, hits: number) {
  return analyzeSnapshot({
    snapshot: { subject: { kind: 'commit', id }, files: [{ path, bytes: Buffer.from('export function run() {\n  return 1;\n}\n') }] },
    excludedOutput: null, coverage: { sourceRoot: '/project', text: lcov(hits) },
  });
}
