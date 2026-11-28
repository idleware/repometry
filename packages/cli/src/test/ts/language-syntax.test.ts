import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import metricsSchema from '../../main/resources/report/json/file-metrics-v1.schema.json' with { type: 'json' };
import inspectionSchema from '../../main/resources/report/json/viewer-inspection-v1.schema.json' with { type: 'json' };
import catalogSchema from '../../main/resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import reportJsonSchema from '../../main/resources/report/json/report-v2.schema.json' with { type: 'json' };
import { analyzeSnapshot } from './helpers/analysis.js';
import { languageRegistry } from '../../main/ts/compose/languages.js';
import { bundledLanguages, defaultCli, languagePlugins } from './helpers/wasm-plugin.js';
import { go } from '@repometry/language-go';
import { python } from '@repometry/language-python';
import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure } from '@repometry/core/internal/model/code-structure.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import type { LanguageSyntax } from '@repometry/core';
import { isLanguageSyntax } from '@repometry/core/internal/model/language.js';
import { reportSchema } from '@repometry/core/internal/model/report.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import { jsSyntax } from '../../main/ts/plugins/language-js/syntax.js';
import { inspectionAsset } from '../../main/ts/report/json/projections/inspection-details.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';

const [goSyntax, pythonSyntax] = [go.language.syntax!, python.language.syntax!];

const fixtureSyntax = { lineComments: [';'], strings: [{ quote: '~' }], keywords: ['zap'] } satisfies LanguageSyntax;

function provider(id: string, extension: string, syntax?: LanguageSyntax): Plugin {
  return { id: 'test-' + id, api: pluginApi, version: '1.0.0', kinds: ['language'],
    providesLanguages: [{ id, label: id, extensions: [extension], ...(syntax === undefined ? {} : { syntax }) }],
    produces: [{ contract: codeStructure.id, persistence: 'transient' }],
    operations: [{ id: 'read', role: 'provider', inputs: { file: sourceFile }, output: codeStructure,
      execute: inputs => ({ path: inputs.read('file', sourceFile).path, lines: 1, functions: 0, cyclomaticFunctions: [] }) }],
  };
}

test('syntax accepts the built-ins and checks markers, word lists and the object shape', async () => {
  for (const id of ['javascript', 'typescript', 'go', 'python']) assert.ok(isLanguageSyntax(bundledLanguages.syntax(id)), id);
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
    ['go', goSyntax], ['python', pythonSyntax]]);
  const lookup = languageRegistry([...languagePlugins, provider('fixture', '.fixture')]);
  for (const languages of [bundledLanguages, lookup]) {
    const entries = inspectionAsset(report, { languages }).inspection.metrics.languages!;
    assert.equal(entries.length, expected.size);
    assert.deepEqual(new Map(entries.map(({ id, syntax }) => [id, syntax])), expected);
    assert.ok(languages.catalog.every(entry => !Object.hasOwn(entry, 'syntax')));
  }
});

test('display syntax reaches view assets without recording a parser or syntax in saved data', async () => {
  const displayOnly = ['main.c', 'main.cpp', 'settings.json', 'site.css', 'Dockerfile'];
  const report = await analyzeSnapshot({
    snapshot: { subject: { kind: 'commit', id: 'c'.repeat(40) },
      files: [...displayOnly, 'plain.rb'].map(path => ({ path, bytes: Buffer.from('\n') })) },
    excludedOutput: null,
  });
  const metrics = inspectionAsset(report, { languages: bundledLanguages }).inspection.metrics;
  for (const id of ['c', 'cpp', 'json', 'css', 'dockerfile']) {
    assert.ok(isLanguageSyntax(metrics.languages?.find(entry => entry.id === id)?.syntax), id);
  }
  assert.ok(metrics.files.filter(file => displayOnly.includes(file.path)).every(file => file.provider === undefined));
  assert.equal(metrics.languages?.find(entry => entry.id === 'ruby')?.syntax, undefined);
  assert.ok(report.pluginData?.languages?.every(language => !Object.hasOwn(language, 'syntax')));
});

test('a language provider controls the display syntax for its language', () => {
  assert.ok(bundledLanguages.syntax('c'));
  assert.equal(languageRegistry([provider('c', '.c', fixtureSyntax)]).syntax('c'), fixtureSyntax);
  assert.equal(languageRegistry([provider('c', '.c')]).syntax('c'), undefined);
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
  const plain = inspectionAsset(original, { languages: bundledLanguages });
  assert.equal(plain.inspection.metrics.languages?.[0]?.syntax, undefined);
  const asset = inspectionAsset(original, { languages: languageRegistry([fixture]) });
  assert.deepEqual(asset.inspection.metrics.languages?.find(entry => entry.id === 'fixture')?.syntax, fixtureSyntax);
  const validator = new Ajv2020({ schemas: [catalogSchema, reportJsonSchema, metricsSchema] });
  const metrics = validator.getSchema(metricsSchema.$id)!;
  const inspection = validator.compile(inspectionSchema);
  const data = JSON.parse(JSON.stringify(asset));
  assert.ok(metrics(data.inspection.metrics), JSON.stringify(metrics.errors));
  assert.ok(inspection(data), JSON.stringify(inspection.errors));

  const show = spawnSync(process.execPath, [defaultCli, 'show', report.subject.id, '--files', '--store', root], { cwd: root, encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout).languages;
  assert.ok(shown.some((entry: { id: string }) => entry.id === 'fixture'));
  assert.ok(shown.every((entry: object) => !Object.hasOwn(entry, 'syntax')));
});
