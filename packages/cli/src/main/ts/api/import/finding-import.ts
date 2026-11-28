import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import { digest } from '@repometry/core/internal/model/snapshot.js';
import type { Finding, FindingLocation } from '@repometry/core/internal/model/finding.js';

import { uniqueScanners, scannerText as text } from '@repometry/core/internal/model/scanner-import.js';
import type { FindingInput, Scanner, ImportMetadata } from '@repometry/core/internal/model/scanner-import.js';
export { findingImportMethods } from '@repometry/core/internal/model/scanner-import.js';
export type { FindingInput } from '@repometry/core/internal/model/scanner-import.js';

interface Imported {
  readonly findings: readonly Finding[];
  readonly metadata: ImportMetadata;
}

type ObjectValue = Record<string, unknown>;
type Level = Finding['level'];
type FindingRecord = Finding | null;
type Parsed = { tools: readonly Scanner[]; items: readonly FindingRecord[]; units: number };
type MapPath = (path: string) => string | null;

export async function importFindings(input: FindingInput, root: string, excludes: (path: string) => boolean,
  knownPaths: ReadonlySet<string> | undefined): Promise<Imported> {
  const bytes = await readFile(input.file);
  let parsed: Parsed;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    const map = (path: string) => repositoryPath(root, path);
    parsed = input.format === 'sarif' ? parseSarif(value, input.category, root)
      : input.format === 'eslint' ? parseESLint(value, map) : parseOSV(value, map);
  } catch {
    throw new Error(`Invalid ${input.format.toUpperCase()} finding input (${input.category})`);
  }
  const { toolVersion, settingsDigest = null, scope = null } = input;
  if (toolVersion !== undefined && (parsed.tools.length !== 1 || !text(toolVersion))) throw new Error('A scanner version override requires one scanner');
  if (settingsDigest !== null && !/^[a-f0-9]{64}$/.test(settingsDigest)) throw new Error('Invalid scanner configuration digest');
  const tools = toolVersion === undefined ? parsed.tools : [{ name: parsed.tools[0]!.name, version: toolVersion }];
  const findings: Finding[] = [];
  let unmapped = 0;
  for (const item of parsed.items) {
    if (item?.path && excludes(item.path)) continue;
    if (item === null || (item.path && knownPaths && !knownPaths.has(item.path))) {
      unmapped++;
      continue;
    }
    const related = item.related?.filter(location => !excludes(location.path) && (!knownPaths || knownPaths.has(location.path)));
    findings.push({ ...item, related: related?.length ? related : undefined });
  }
  return { findings, metadata: { format: input.format, category: input.category, inputDigest: digest(bytes), tools, settingsDigest, scope,
    imported: findings.length, reported: parsed.items.length, unmapped, units: parsed.units } };
}

function parseSarif(value: unknown, category: 'lint' | 'security' | 'secret', root: string): Parsed {
  const report = object(value);
  if (report.version !== '2.1.0') throw new Error('Unknown SARIF version');
  const runs = array(report.runs);
  const tools: Scanner[] = [];
  const items: FindingRecord[] = [];
  for (const value of runs) {
    const run = object(value);
    const driver = object(object(run.tool).driver);
    const tool = requiredText(driver.name);
    tools.push({ name: tool, version: text(driver.semanticVersion) ?? text(driver.version) ?? null });
    const rules = optionalArray(driver.rules);
    const rulesById = new Map(rules.filter(isRecord).map(rule => [text(rule.id), rule]));
    const artifacts = optionalArray(run.artifacts);
    const bases = isRecord(run.originalUriBaseIds) ? run.originalUriBaseIds : {};
    if (optionalArray(run.invocations).some(invocation => object(invocation).executionSuccessful === false)) {
      throw new Error('SARIF run reports an execution failure');
    }
    for (const candidate of optionalArray(run.results)) {
      const result = object(candidate);
      if (result.kind !== undefined && result.kind !== 'fail' || optionalArray(result.suppressions).some(suppression =>
        object(suppression).status === undefined || object(suppression).status === 'accepted')) continue;
      const id = text(result.ruleId);
      const descriptor = safeIndex(result.ruleIndex) ? rules[result.ruleIndex] : id ? rulesById.get(id) : undefined;
      const rule = isRecord(descriptor) ? descriptor : {};
      const defaultConfiguration = isRecord(rule.defaultConfiguration) ? rule.defaultConfiguration : {};
      const level = lookupLevel(result.level ?? defaultConfiguration.level);
      const ruleId = id ?? text(rule.id) ?? '(unclassified)';
      const message = category === 'secret' ? 'Potential secret reported by a scanner' : sarifMessage(result.message);
      const locations = optionalArray(result.locations).map(location => sarifLocation(location, artifacts, bases, root));
      const primary = locations.find(location => location && location.path !== null);
      const related = locations.filter((location): location is FindingLocation =>
        location !== primary && location !== undefined && location.path !== null && location.line !== undefined && location.endLine !== undefined);
      items.push(locations.some(location => location?.path === null) && !primary ? null : {
        tool, rule: ruleId, category, level, message, ...(primary?.path && { ...primary, path: primary.path }), related,
      });
    }
  }
  return { tools: uniqueScanners(tools), items, units: runs.length };
}

function sarifMessage(value: unknown): string {
  const message = object(value);
  return text(message.text) ?? text(message.markdown) ?? text(message.id) ?? '(missing message)';
}

function sarifLocation(value: unknown, artifacts: readonly unknown[], bases: ObjectValue, root: string):
  { path: string | null; line?: number; endLine?: number } | undefined {
  const location = object(value);
  const physical = location.physicalLocation;
  if (!isRecord(physical) || !isRecord(physical.artifactLocation)) return;
  const artifact = physical.artifactLocation;
  const stored = safeIndex(artifact.index) ? artifacts[artifact.index] : undefined;
  const fallback = isRecord(stored) && isRecord(stored.location) ? stored.location : {};
  const uri = text(artifact.uri) ?? text(fallback.uri);
  if (!uri) return { path: null };
  const baseId = text(artifact.uriBaseId) ?? text(fallback.uriBaseId);
  const base = pathToFileURL(`${root}${sep}`);
  const resolvedBase = baseId ? sarifBase(baseId, bases, base, new Set()) : base;
  const file = fileLocation(uri, resolvedBase);
  const path = file === null ? null : repositoryPath(root, file);
  const source = isRecord(physical.region) ? physical.region : {};
  return { path, ...range(source.startLine, source.endLine) };
}

function sarifBase(id: string, bases: ObjectValue, fallback: URL, visited: Set<string>): URL | null {
  if (visited.has(id)) return null;
  if (!Object.hasOwn(bases, id)) return id === '%SRCROOT%' ? fallback : null;
  visited.add(id);
  const item = object(bases[id]);
  const uri = text(item.uri);
  const parent = text(item.uriBaseId);
  const base = parent ? sarifBase(parent, bases, fallback, visited) : fallback;
  const file = uri && fileLocation(uri, base);
  return file ? pathToFileURL(file) : null;
}

function fileLocation(uri: string, base: URL | null): string | null {
  try {
    const url = base === null ? new URL(uri) : new URL(uri, base);
    if (url.protocol !== 'file:' || url.search !== '' || url.hash !== '') return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

function parseESLint(value: unknown, map: MapPath): Parsed {
  const files = array(isRecord(value) ? value.results : value);
  const items: FindingRecord[] = [];
  for (const candidate of files) {
    const file = object(candidate);
    const path = map(requiredText(file.filePath));
    for (const value of array(file.messages)) {
      const message = object(value);
      items.push(path === null ? null : { tool: 'eslint', rule: text(message.ruleId) ?? (message.fatal === true ? 'parse-error' : '(unclassified)'),
        category: 'lint', level: message.severity === 2 ? 'high' : message.severity === 1 ? 'medium' : 'unknown',
        message: requiredText(message.message), path, ...range(message.line, message.endLine) });
    }
  }
  return { tools: [{ name: 'eslint', version: null }], items, units: files.length };
}

function parseOSV(value: unknown, map: MapPath): Parsed {
  const report = object(value);
  const sources = report.results === null ? [] : array(report.results);
  const items: FindingRecord[] = [];
  let units = 0;
  for (const value of sources) {
    const source = object(value);
    const pathValue = isRecord(source.source) ? text(source.source.path) : undefined;
    const path = pathValue === undefined ? undefined : map(pathValue);
    for (const candidate of array(source.packages)) {
      units++;
      const listed = object(candidate);
      const pkg = object(listed.package);
      const name = requiredText(pkg.name);
      const version = text(pkg.version) ?? text(pkg.commit);
      const advisories = new Set(optionalArray(listed.vulnerabilities).map(value => requiredText(object(value).id)));
      for (const entry of optionalArray(listed.groups)) {
        const group = object(entry);
        const identifiers = array(group.ids).map(requiredText);
        if (advisories.size > 0 && identifiers.some(id => advisories.has(id))) {
          const canonical = advisoryId([...identifiers, ...optionalArray(group.aliases).map(requiredText)]);
          add(canonical, scoreLevel(group.max_severity));
          for (const id of identifiers) advisories.delete(id);
        }
      }
      for (const advisory of advisories) add(advisory, 'unknown');

      function add(rule: string, level: Level): void {
        items.push(path === null ? null : { tool: 'osv-scanner', rule, category: 'dependency', level, path,
          message: `Advisory for ${name}${version ? `@${version}` : ''}` });
      }
    }
  }
  return { tools: [{ name: 'osv-scanner', version: null }], items, units };
}

function advisoryId(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return sorted.find(id => id.startsWith('CVE-')) ?? sorted.find(id => id.startsWith('GHSA-')) ?? sorted[0]!;
}

function scoreLevel(value: unknown): Level {
  const numeric = typeof value === 'string' && /^(?:\d+|\d+\.\d+)$/.test(value) ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0 || numeric > 10) return 'unknown';
  return numeric >= 7 ? 'high' : numeric >= 4 ? 'medium' : 'low';
}

function lookupLevel(value: unknown): Level {
  return value === 'error' ? 'high' : value === 'warning' ? 'medium' : value === 'note' ? 'low' : 'unknown';
}

function range(first: unknown, last: unknown): { line?: number; endLine?: number } {
  if (!safeIndex(first) || first === 0) return {};
  return { line: first, endLine: safeIndex(last) && last >= first ? last : first };
}

function repositoryPath(root: string, path: string): string | null {
  if (/[\0\r\n]/.test(path)) return null;
  const result = relative(root, resolve(root, path));
  if (result === '' || isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`)) return null;
  return result.split(sep).join('/');
}

function requiredText(value: unknown): string {
  const result = text(value);
  if (result === undefined) throw new Error('Invalid scanner field');
  return result;
}

function object(value: unknown): ObjectValue {
  if (!isRecord(value)) throw new Error('Expected scanner object');
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected scanner array');
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return value === undefined ? [] : array(value);
}

function safeIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
