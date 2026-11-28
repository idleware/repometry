import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import config from '../../main/resources/report/json/config-v2.schema.json' with { type: 'json' };
import manifest from '@repometry/core/plugin-v1.schema.json' with { type: 'json' };
import type { DiffCoveragePorts, DiffCoverageRequest, DiffCoverageSource, FindingInput, IgnoreEntry, InspectRequest,
  ReviewOptions, ReviewRequest } from 'repometry';
import type { Candidate, Check, CloneSource, CodeStructure, DataContract, Finding, FindingLocation, FindingResult, FunctionComplexity,
  InspectionInputs, LanguageDisplay, LanguageSyntax, Measurement, MetricDescriptor, Operation, PluginManifest, ProductOutput,
  SourceFile, StructuralObservation } from 'repometry/plugin';
import { retiredMessages, retiredProductionMessages } from './message-vocabulary.js';
import { parseConfig } from '../../main/ts/cli/config.js';

const retiredFields = ['api', 'protocol', 'tool', 'kinds', 'settings', 'config', 'claims', 'extensions', 'globs', 'pathGlobs',
  'rule', 'rules', 'providesLanguages', 'sources'] as const;
const retired = new Set<string>(retiredFields);
const cli = resolve('target/main/ts/cli/main.js');

type Keys<T> = T extends unknown ? keyof T : never;
type PluginReference = Exclude<NonNullable<InspectRequest['plugins']>[number], string | PluginManifest>;
type ExportedAuthorFields = Keys<PluginManifest | NonNullable<PluginManifest['languages']>[number]
  | NonNullable<PluginManifest['requires']> | Awaited<ReturnType<PluginManifest['create']>> | PluginReference | ProductOutput
  | Candidate | Check | CloneSource | CodeStructure | DataContract | Finding | FindingLocation | FindingResult | FunctionComplexity
  | InspectionInputs | LanguageDisplay | LanguageSyntax | Measurement | MetricDescriptor | Operation | SourceFile | StructuralObservation
  | DiffCoveragePorts | DiffCoverageRequest | DiffCoverageSource | FindingInput | IgnoreEntry | InspectRequest | ReviewOptions | ReviewRequest>;
type RetiredAuthorFields = Extract<typeof retiredFields[number] | 'operationCache', ExportedAuthorFields>;

test('inspection config, manifest and discovery use the same vocabulary', async () => {
  const typeFields: RetiredAuthorFields extends never ? true : RetiredAuthorFields = true;
  assert.equal(typeFields, true);
  assert.deepEqual(forbiddenKeys(config, true), []);
  assert.deepEqual(forbiddenKeys(manifest, true), []);
  const listing: unknown = JSON.parse(execFileSync(process.execPath, [cli, 'plugins', '--no-config'], { encoding: 'utf8' }));
  assert.deepEqual(forbiddenKeys(listing, false), []);
  for (const entry of ['@repometry/core', 'repometry', 'repometry/plugin']) {
    const keys = Object.keys(await import(entry));
    assert.deepEqual(keys.filter(key => /(?:Rule|Claims|Protocol|pluginApi|^Plugin$)/.test(key)), [], entry);
  }
});

test('old config fields explain their replacements and ignore errors identify their paths', () => {
  const errors = [
    [{ sources: 'local' }, 'Config sources is renamed. Write source.'],
    [{ plugins: [{ use: 'secrets', include: [42] }] }, 'Config plugins/0/include/0 must be a string'],
    [{ components: [{ name: 'CLI', pathGlobs: ['src/**'] }] },
      'Config components/0/pathGlobs is renamed. Write include.'],
    [{ ignore: [{ tool: 'repometry', reason: 'fixture' }] }, 'Config ignore/0/tool is renamed. Write plugin.'],
    [{ ignore: [{ path: [], reason: 'fixture' }] }, 'Config ignore/0/path must be a glob or a nonempty list of globs'],
    [{ ignore: [{ category: 'coverage', check: 'branch', reason: 'fixture' }] },
      'Config ignore/0/check is unavailable for coverage because coverage has no findings'],
    [{ ignore: [{ category: 'coverage', plugin: 'other', reason: 'fixture' }] }, 'Config ignore/0/plugin must be lcov for coverage'],
    [{ ignore: [{ category: 'coverage', reason: 'fixture' }] },
      'Config ignore/0/path is required for coverage to identify the files to exclude'],
    [{ ignore: [{ check: 'complexity' }] }, 'Config ignore/0/reason is required'],
    [{ ignore: [{ reason: 'fixture' }] }, 'Config ignore/0 needs at least one of category, plugin, check or path'],
  ] as const;
  const validate = new Ajv2020().compile(config);
  for (const [value, message] of errors) {
    assert.throws(() => parseConfig(value), { message });
    assert.equal(validate(value), false, JSON.stringify(value));
  }
  const result = spawnSync(process.execPath, [cli, 'report', '--sources', 'none'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Did you mean --source/);
});


test('production errors and diagnostics use author vocabulary', () => {
  const sample = `
    throw new Error('Rule ' + id + ' references an undeclared metric');
    throw new Error(\`Language plugin \${plugin.id} must claim files and provide code structure\`);
    emitDiagnostic('Multiple language providers claim ' + path);
    const note = 'Legacy settings';
    process.stderr.write('Rules are disabled');
    throw badFormat('Unknown claim');
    throw new Error('Tool timed out');
    const harmless = { rule: 'catalog-id', reason: 'Not available' };
  `;
  assert.equal(retiredMessages(sample).length, 6);
  assert.deepEqual(retiredProductionMessages(), []);
});

function forbiddenKeys(value: unknown, schema: boolean): string[] {
  if (Array.isArray(value)) return value.flatMap(item => forbiddenKeys(item, schema));
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value);
  const fields = schema && 'properties' in value && value.properties && typeof value.properties === 'object'
    ? Object.keys(value.properties) : schema ? [] : entries.map(([key]) => key);
  return [...fields.filter(key => retired.has(key)), ...entries.flatMap(([, item]) => forbiddenKeys(item, schema))];
}
