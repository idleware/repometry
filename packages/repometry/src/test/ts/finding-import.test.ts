import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspect } from '../../main/ts/compose/inspect.js';
import { findingImportMethods, importFindings } from '../../main/ts/api/import/finding-import.js';
import type { FindingInput } from '../../main/ts/api/import/finding-import.js';

test('scanner imports persist normalized private findings and redact secret messages', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repometry-scanner-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.js'), 'export const ready = true;\n');
  const secret = await input({ format: 'sarif', category: 'secret' }, {
    version: '2.1.0', runs: [{ tool: { driver: { name: 'example-scanner', semanticVersion: '2.0.1' } },
      originalUriBaseIds: { '%SRCROOT%': { uri: pathToFileURL(`${root}/`).href } },
      artifacts: [{ location: { uri: 'index.js', uriBaseId: '%SRCROOT%' } }],
      results: [
        { ruleId: 'token-present', level: 'error', message: { text: 'private-example-test-value' }, locations: [
          { physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 1 } } },
        ] },
        { ruleId: 'suppressed-rule', message: { text: 'ignored' }, suppressions: [{ status: 'accepted' }] },
      ],
    }],
  });
  const eslint = await input({ format: 'eslint', category: 'lint' }, [{ filePath: join(root, 'index.js'), messages: [
    { ruleId: 'example', severity: 1, message: 'Example lint finding', line: 1 },
  ] }, { filePath: join(root, 'vendor', 'skip.js'), messages: [
    { ruleId: 'example', severity: 2, message: 'Excluded finding', line: 1 },
  ] }]);
  const osv = await input({ format: 'osv', category: 'dependency' }, { results: [{ source: { path: 'package-lock.json' }, packages: [{
    package: { name: 'example-package', version: '1.0.0' },
    vulnerabilities: [{ id: 'OSV-A' }, { id: 'GHSA-A' }, { id: 'OSV-B' }],
    groups: [{ ids: ['OSV-A', 'GHSA-A'], aliases: ['CVE-2000-0000'], max_severity: '7.9' }],
  }] }] });
  const output = join(root, '.repometry');
  const report = await inspect({ directory: root, output, source: { workingTree: true }, exclude: ['vendor'], findingInputs: [secret, eslint, osv] });
  assert.deepEqual(report.findings?.map(({ tool, rule, path, level, category }) => [tool, rule, path, level, category]), [
    ['example-scanner', 'token-present', 'index.js', 'high', 'secret'],
    ['eslint', 'example', 'index.js', 'medium', 'lint'],
    ['osv-scanner', 'CVE-2000-0000', 'package-lock.json', 'high', 'dependency'],
    ['osv-scanner', 'OSV-B', 'package-lock.json', 'unknown', 'dependency'],
  ]);
  assert.equal(report.findings?.[0]?.message, 'Potential secret reported by a scanner');
  const bytes = await readFile(join(output, 'working-trees', report.subject.id, 'report.json'), 'utf8');
  assert.ok(!bytes.includes('private-example-test-value') && !bytes.includes(root));
  assert.equal(findingImportMethods(report.appliedConfig.findingImports).length, 3);
  const outOfScope = await importFindings(osv, root, () => false, new Set(['index.js']));
  assert.equal(outOfScope.metadata.unmapped, 2);
  assert.deepEqual(outOfScope.findings, []);

  async function input(variant: Omit<FindingInput, 'file'>, json: unknown): Promise<FindingInput> {
    const file = join(root, `${variant.format}.json`);
    await writeFile(file, JSON.stringify(json));
    return { ...variant, file } as FindingInput;
  }
});
