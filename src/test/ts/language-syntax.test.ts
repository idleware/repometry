import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import metricsSchema from '../../main/resources/report/json/file-metrics-v1.schema.json' with { type: 'json' };
import inspectionSchema from '../../main/resources/report/json/viewer-inspection-v1.schema.json' with { type: 'json' };
import catalogSchema from '../../main/resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import reportJsonSchema from '../../main/resources/report/json/report-v2.schema.json' with { type: 'json' };
import { analyzeSnapshot } from './helpers/analysis.js';
import { defaultLanguages, languageRegistry } from '../../main/ts/compose/languages.js';
import { hostLanguages } from '../../main/ts/plugins/built-in.js';
import { pluginApi, codeStructure, sourceFile } from '../../main/ts/plugin.js';
import type { LanguageSyntax, Plugin } from '../../main/ts/plugin.js';
import { isLanguageSyntax } from '../../main/ts/core/model/language.js';
import { reportSchema } from '../../main/ts/core/model/report.js';
import type { Report } from '../../main/ts/core/model/report.js';
import { jsSyntax } from '../../main/ts/plugins/language-js/syntax.js';
import { inspectionAsset } from '../../main/ts/report/json/projections/inspection-details.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';

const fixtureSyntax = { lineComments: [';'], strings: [{ quote: '~' }], keywords: ['zap'] } satisfies LanguageSyntax;
const cli = resolve('target/main/ts/cli/main.js');

function provider(id: string, extension: string, syntax?: LanguageSyntax): Plugin {
  return { id: 'test-' + id, api: pluginApi, version: '1.0.0', kinds: ['language'],
    providesLanguages: [{ id, label: id, extensions: [extension], ...(syntax === undefined ? {} : { syntax }) }],
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { file: sourceFile }, output: codeStructure,
      execute: inputs => ({ path: inputs.read('file', sourceFile).path, lines: 1, functions: 0, cyclomaticFunctions: [] }) }],
  };
}

test('syntax accepts the built-ins and checks markers, word lists and the object shape', async () => {
  for (const id of ['javascript', 'typescript', 'go', 'python']) assert.ok(isLanguageSyntax(defaultLanguages.syntax(id)), id);
  assert.ok(isLanguageSyntax(fixtureSyntax));
  for (const syntax of [
    { lineComments: [''] }, { lineComments: ['a b'] }, { lineComments: ['abcdefghij'] },
    { blockComments: [['/*']] }, { strings: [{ quote: '"', escapes: true }] },
    { strings: [{ quote: 'a\n' }] }, { strings: [{ quote: '~', raw: 1 }] },
    { keywords: ['@word'] }, { keywords: Array.from({ length: 513 }, () => 'word') },
    { regexAfter: ['not a word'] }, { stringPrefixes: ['1bad'] }, { unknown: [] },
  ]) assert.equal(isLanguageSyntax(syntax), false, JSON.stringify(syntax));

  const bad = provider('fixture', '.fixture', { lineComments: [''] });
  await assert.rejects(() => analyzeSnapshot({ snapshot: { subject: { kind: 'commit', id: 'a'.repeat(40) }, files: [] },
    excludedOutput: null }, [bad]), /Invalid provided languages for plugin test-fixture/);
});

test('rendering old reports attaches built-in syntax and falls back by language ID without probing tools', () => {
  const report: Report = { schema: reportSchema, subject: { kind: 'commit', id: 'a'.repeat(40) },
    generatedAt: '2026-11-26T00:00:00.000Z', status: 'complete', scope: { files: 4, parsed: 4 }, appliedConfig: {},
    definitions: {}, diagnostics: [], measurements: [],
    pluginData: { metrics: [], measured: [], rules: [], products: {}, inventory: [
      { path: 'one.js', language: 'javascript' }, { path: 'two.ts', language: 'typescript' },
      { path: 'three.go', language: 'go' }, { path: 'four.py', language: 'python' },
    ].map(file => ({ ...file, lines: 1, analysed: true })) },
  };
  const expected = new Map([['javascript', jsSyntax], ['typescript', jsSyntax],
    ...hostLanguages.map(({ language, syntax }) => [language, syntax] as const)]);
  const lookup = languageRegistry([provider('go', '.go')], false);
  for (const languages of [defaultLanguages, lookup]) {
    const entries = inspectionAsset(report, { languages }).inspection.metrics.languages!;
    assert.equal(entries.length, expected.size);
    assert.deepEqual(new Map(entries.map(({ id, syntax }) => [id, syntax])), expected);
    assert.ok(languages.catalog.every(entry => !Object.hasOwn(entry, 'syntax')));
  }
});

test('registered syntax goes to the inspection asset, validates on the wire, and stays out of saved data and show', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repometry-language-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = provider('fixture', '.fixture', fixtureSyntax);
  const report = await analyzeSnapshot({
    snapshot: { subject: { kind: 'commit', id: 'b'.repeat(40) }, files: [{ path: 'code.fixture', bytes: Buffer.from('zap ~a~ ; note\n') }] },
    excludedOutput: null,
  }, [fixture]);
  const plugins = report.appliedConfig.plugins;
  assert.ok(Array.isArray(plugins));
  const declared = plugins.find(plugin => plugin.id === 'test-fixture')?.providesLanguages;
  assert.deepEqual(declared, [{ id: 'fixture', label: 'fixture', extensions: ['.fixture'] }]);
  assert.ok(report.pluginData?.languages?.every(language => !Object.hasOwn(language, 'syntax')));

  const store = new LocalReportStore(root);
  await store.save(report);
  const original = await store.read(report.subject);
  const plain = inspectionAsset(original, { languages: defaultLanguages });
  assert.equal(plain.inspection.metrics.languages?.[0]?.syntax, undefined);
  const asset = inspectionAsset(original, { languages: languageRegistry([fixture], false) });
  assert.deepEqual(asset.inspection.metrics.languages?.find(entry => entry.id === 'fixture')?.syntax, fixtureSyntax);
  const validator = new Ajv2020({ schemas: [catalogSchema, reportJsonSchema, metricsSchema] });
  const metrics = validator.getSchema(metricsSchema.$id)!;
  const inspection = validator.compile(inspectionSchema);
  const data = JSON.parse(JSON.stringify(asset));
  assert.ok(metrics(data.inspection.metrics), JSON.stringify(metrics.errors));
  assert.ok(inspection(data), JSON.stringify(inspection.errors));

  const show = spawnSync(process.execPath, [cli, 'show', report.subject.id, '--files', '--store', root], { cwd: root, encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout).languages;
  assert.ok(shown.some((entry: { id: string }) => entry.id === 'fixture'));
  assert.ok(shown.every((entry: object) => !Object.hasOwn(entry, 'syntax')));
});
