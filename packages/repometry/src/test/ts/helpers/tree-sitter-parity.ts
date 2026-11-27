// Set REPOMETRY_LEGACY_BUILD to the absolute path to an older build’s target/main/ts directory.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { Operation, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import type { CodeStructure } from '@repometry/core/internal/model/code-structure.js';
import { cloneSources } from '@repometry/core/internal/model/clone-source.js';
import type { Candidate, CloneSource } from '@repometry/core/internal/model/clone-source.js';
import type { Finding, FindingResult } from '@repometry/core/internal/model/finding.js';
import type { SourceFile } from '@repometry/core/internal/model/source.js';
import { sourceFile, sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import { duplication } from '../../../main/ts/plugins/duplication/duplication.js';
import { treeSitter } from './wasm-plugin.js';

const extensions = { go: '.go', python: '.py' };
const encodingErrors = new Set(['ERR_ENCODING_INVALID_ENCODED_DATA', 'ERR_ENCODING_NOT_SUPPORTED']);

const fields = ['path', 'lines', 'functions', 'classes', 'cognitiveComplexity', 'cognitiveFunctions', 'cyclomaticFunctions',
  'functionBodies', 'observations', 'commentLines', 'codeLines'] as const satisfies readonly (keyof CodeStructure)[];

function filesIn(root: string, extension: string, pathList?: string): string[] {
  if (pathList) return JSON.parse(readFileSync(pathList, 'utf8')) as string[];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith(extension))
    .map(file => relative(root, join(file.parentPath, file.name))).sort();
}

interface Baseline {
  readonly rows: Map<string, CodeStructure>;
  readonly diagnostics: string[];
  batches: number;
  splits: number;
}

async function baseline(operation: Operation, files: readonly SourceFile[], result: Baseline): Promise<void> {
  try {
    result.batches++;
    const value = await operation.execute({
      read: <T>(name: string, contract: { readonly id: string }) => {
        if (name !== 'files' || contract.id !== sourceFiles.id) throw new Error('Unexpected native input');
        return files as T;
      },
      emitDiagnostic: message => result.diagnostics.push(message),
    });
    if (!codeStructures.accepts(value)) throw new Error('Native parser returned invalid structures');
    for (const row of value) result.rows.set(row.path, row);
  } catch (error) {
    if (messageOf(error) !== 'Tool exceeded the output limit' || files.length < 2) {
      throw new Error('Native parser failed in a batch starting at ' + files[0]?.path, { cause: error });
    }
    result.splits++;
    const mid = Math.floor(files.length / 2);
    await baseline(operation, files.slice(0, mid), result);
    await baseline(operation, files.slice(mid), result);
  }
}

async function next(file: SourceFile, rejected: Record<string, string>): Promise<CodeStructure | undefined> {
  try {
    const value = await treeSitter.operations[0]!.execute({
      read: <T>(name: string, contract: { readonly id: string }) => {
        assert.equal(name, 'file', 'WASM input port');
        assert.equal(contract.id, sourceFile.id, 'WASM input contract');
        return file as T;
      },
    });
    assert.ok(codeStructure.accepts(value), 'WASM parser returned invalid structure');
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
    if (!(error instanceof SyntaxError) && !encodingErrors.has(code)) {
      throw new Error('WASM parser failed while reading ' + file.path, { cause: error });
    }
    rejected[file.path] = messageOf(error);
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type StrictFindings = readonly (readonly [string, readonly string[]])[];
function range({ path, line, endLine }: Pick<Finding, 'path' | 'line' | 'endLine'>): string {
  return path + ':' + line + '-' + endLine;
}

function group(finding: Finding): readonly [string, readonly string[]] {
  return [finding.rule, [finding, ...finding.related ?? []].map(range).sort()];
}

async function cloneFindings(sources: readonly CloneSource[]) {
  const result = await duplication.operations[0]!.execute({
    read: <T>(_name: string, contract: { readonly id: string }) => {
      assert.equal(contract.id, cloneSources.id, 'Duplication input contract');
      return sources as T;
    },
  }) as FindingResult;
  const key = (finding: Finding) => JSON.stringify(group(finding));
  return { findings: result.findings, keys: new Set(result.findings.map(key)),
    lines: result.measurements.reduce((total, row) => total + (row.value ?? 0), 0) };
}

function examples(findings: readonly Finding[], keys: ReadonlySet<string>): StrictFindings {
  return findings.filter(row => !keys.has(JSON.stringify(group(row))))
    .sort((left, right) => (right.effortMinutes ?? 0) - (left.effortMinutes ?? 0)).slice(0, 10).map(group);
}

function groupRanges(findings: readonly Finding[]) {
  return new Set(findings.map(finding => JSON.stringify(group(finding)[1])));
}

function candidateRange({ line, endLine }: Candidate) {
  return line + ':' + endLine;
}

async function compareClones(native: readonly CloneSource[], wasm: readonly CloneSource[]) {
  const [before, after] = await Promise.all([cloneFindings(native), cloneFindings(wasm)]);
  const beforeRanges = groupRanges(before.findings);
  const afterRanges = groupRanges(after.findings);
  const wasmByPath = new Map(wasm.map(clones => [clones.path, clones.candidates]));
  const candidates = { native: 0, wasm: wasm.reduce((total, row) => total + row.candidates.length, 0), sameRanges: 0, exact: 0, similar: 0 };
  for (const { path, candidates: old } of native) {
    candidates.native += old.length;
    const current = new Map((wasmByPath.get(path) ?? []).map(row => [candidateRange(row), row]));
    for (const item of old) {
      const match = current.get(candidateRange(item));
      if (!match) continue;
      candidates.sameRanges++;
      candidates.exact += Number(match.exact === item.exact);
      candidates.similar += Number(match.similar === item.similar);
    }
  }
  return { candidates,
    native: { groups: before.findings.length, lines: before.lines, repeatedGroups: before.findings.length - beforeRanges.size },
    wasm: { groups: after.findings.length, lines: after.lines, repeatedGroups: after.findings.length - afterRanges.size },
    sameRangeGroups: [...beforeRanges].filter(key => afterRanges.has(key)).length,
    sameRuleAndRangeGroups: [...before.keys].filter(key => after.keys.has(key)).length,
    lost: examples(before.findings, after.keys), added: examples(after.findings, before.keys) };
}

async function compare(operation: Operation, files: readonly SourceFile[]) {
  const native: Baseline = { rows: new Map(), diagnostics: [], batches: 0, splits: 0 };
  const nativeStart = performance.now();
  // Split only when the native runner hits its bounded output.
  for (let offset = 0; offset < files.length; offset += 80) await baseline(operation, files.slice(offset, offset + 80), native);
  const nativeMs = performance.now() - nativeStart;
  const diffs = new Map(fields.map(field => [field, [] as string[]]));
  const wasmRejected: Record<string, string> = {};
  const wasmClones: CloneSource[] = [];
  let compared = 0;
  const wasmStart = performance.now();
  for (const file of files) {
    const actual = await next(file, wasmRejected);
    if (!actual) continue;
    if (actual.clones) wasmClones.push(actual.clones);
    const expected = native.rows.get(file.path);
    if (!expected) continue;
    compared++;
    for (const field of fields) {
      if (!isDeepStrictEqual(actual[field], expected[field])) diffs.get(field)!.push(file.path);
    }
  }
  const wasmMs = performance.now() - wasmStart;
  const nativeClones = [...native.rows.values()].flatMap(row => row.clones ?? []);
  const nativeRejected = files.filter(file => !native.rows.has(file.path)).map(file => file.path);
  const wasRejected = (path: string) => Object.hasOwn(wasmRejected, path);
  return { files: files.length, compared, nativeRejected, wasmRejected, bothRejected: nativeRejected.filter(wasRejected),
    wasmOnlyRejected: Object.keys(wasmRejected).filter(path => native.rows.has(path)),
    nativeDiagnostics: native.diagnostics, batches: native.batches, splits: native.splits, nativeMs, wasmMs,
    fields: Object.fromEntries([...diffs].map(([field, paths]) => [field, { equal: compared - paths.length, differences: paths }])),
    clones: await compareClones(nativeClones, wasmClones) };
}

const [language, directory, pathList] = process.argv.slice(2);
if (!directory || (language !== 'go' && language !== 'python')) throw new Error('Use go or python, a corpus directory, and optionally a JSON path list');
const legacy = process.env.REPOMETRY_LEGACY_BUILD;
if (!legacy) throw new Error('Set REPOMETRY_LEGACY_BUILD to the old build’s target/main/ts directory');
const legacyModule = pathToFileURL(resolve(legacy, 'compose/native-language-plugins.js'));
const { nativeLanguagePlugins } = await import(legacyModule.href) as {
  nativeLanguagePlugins(): readonly (Plugin & { unavailableReason?: string })[];
};
const plugin = nativeLanguagePlugins().find(plugin => plugin.providesLanguages?.some(value => value.id === language));
const operation = plugin?.operations[0];
if (!operation) throw new Error(plugin?.unavailableReason ?? 'No native parser for ' + language);
const root = resolve(directory);
const paths = filesIn(root, extensions[language], pathList);
const files = paths.map(path => ({ path, bytes: readFileSync(join(root, path)) }));
const result = await compare(operation, files);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.wasmOnlyRejected.length
  || Object.values(result.fields).some(({ differences }) => differences.length) ? 1 : 0;
