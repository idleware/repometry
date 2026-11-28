import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileTypeId, fileTypes } from '@repometry/core/internal/model/file-types.js';
import { reportSchema } from '@repometry/core/internal/model/report.js';
import type { Report } from '@repometry/core/internal/model/report.js';
import { fileMetrics } from '../../main/ts/report/json/projections/file-metrics.js';

const descriptors = new Map(fileTypes.map(type => [type.id, type]));

test('file types recognize exact manifests and lockfiles before extensions', () => {
  for (const [path, label] of [
    ['tools/go.mod', 'Go module'], ['tools/go.sum', 'Go checksums'], ['py.typed', 'Other'],
    ['scripts/build.bat', 'Batch'], ['scripts/setup.zsh', 'Shell'], ['scripts/setup.fish', 'Shell'],
    ['src/main.go', 'Go'], ['Containerfile.dev', 'Dockerfile'], ['.bash_profile', 'Shell'],
  ] as const) {
    assert.equal(descriptors.get(fileTypeId(path))?.label, label, path);
  }
  for (const name of [
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'flake.lock',
    'mix.lock', 'pubspec.lock', 'packages.lock.json', 'gradle.lockfile',
  ]) {
    assert.equal(descriptors.get(fileTypeId(`tools/${name}`))?.label, 'Lockfile', name);
  }
  assert.deepEqual(['notes.mod', 'notes.sum', 'notes.typed', 'notes.lock', 'cargo.lock', 'go.mod.backup', 'copy-package-lock.json'].map(path => fileTypeId(path)),
    ['mod', 'sum', 'typed', 'lock', 'lock', 'backup', 'json']);
  for (const id of ['go-module', 'go-checksums', 'lockfile', 'batch', 'shell']) {
    assert.match(descriptors.get(id)?.color ?? '', /^#[\da-f]{6}$/i, id);
  }
});

test('saved file inventories retain plugin languages while gaining names for catalog file types', () => {
  const report: Report = {
    schema: reportSchema, subject: { kind: 'commit', id: 'a'.repeat(40) }, generatedAt: '2026-11-21T00:00:00Z',
    status: 'complete', scope: { files: 2, parsed: 2 }, appliedConfig: {}, definitions: {}, measurements: [], diagnostics: [],
    pluginData: {
      metrics: [], measured: [], rules: [], products: {},
      languages: [{ id: 'custom', label: 'Custom' }],
      inventory: [
        { path: 'go.mod', lines: 1, language: 'mod', analysed: false },
        { path: 'go.sum', lines: 2, language: 'sum', analysed: false },
        { path: 'package-lock.json', lines: 3, language: 'json', analysed: false },
        { path: 'src/py.typed', lines: 0, language: 'typed', analysed: false },
        { path: 'support/uv.lock', lines: 4, language: 'legacy', provider: 'scanner/parse', analysed: true },
        { path: 'tools/go.mod', lines: 1, language: 'custom', analysed: true },
      ],
    },
  };
  const metrics = fileMetrics(report);
  assert.deepEqual(metrics.files.map(file => [file.path, metrics.languages?.[file.language!]?.label, file.analysed]), [
    ['go.mod', 'Go module', false], ['go.sum', 'Go checksums', false], ['package-lock.json', 'Lockfile', false],
    ['src/py.typed', 'Other', false], ['support/uv.lock', 'LEGACY', true], ['tools/go.mod', 'Custom', true],
  ]);
});
