import { category } from '../model/inspection-category.js';
import { isRecord } from '../model/plugin-data.js';
import type { FindingIgnoreRule, InspectionIgnoreCategory, RecordedFindingIgnore } from '../model/ignore-rule.js';
import { exclusionMatcher, normalizeExclusions } from './exclusions.js';

const coveragePlugin = 'lcov';

export function readIgnoreRules(value: unknown): readonly FindingIgnoreRule[] {
  if (!Array.isArray(value)) throw new Error('Config ignore must be an array');
  return value.map(readIgnore);
}

function readIgnore(value: unknown, index: number): FindingIgnoreRule {
  const base = 'Config ignore/' + index;
  if (!isRecord(value)) throw new Error(base + ' must be an object');
  if (Object.hasOwn(value, 'tool')) throw new Error(base + '/tool is renamed. Write plugin.');
  if (Object.hasOwn(value, 'rule')) throw new Error(base + '/rule is renamed. Write check.');
  const unknown = Object.keys(value).find(key => !['category', 'plugin', 'check', 'path', 'reason'].includes(key));
  if (unknown !== undefined) throw new Error(base + ' accepts category, plugin, check, path and reason');
  const category = readCategory(value.category, base);
  const plugin = readText(value.plugin, base + '/plugin', 'must name a plugin or the reporter named in an imported finding');
  const check = readText(value.check, base + '/check', 'must name a check');
  const path = readPaths(value.path, base + '/path');
  const reason = readText(value.reason, base + '/reason', 'must give a reason');
  if (reason === undefined) throw new Error(base + '/reason is required');
  if ([category, plugin, check, path].every(selector => selector === undefined)) {
    throw new Error(base + ' needs at least one of category, plugin, check or path');
  }
  if (category === 'coverage') validateCoverage(plugin, check, path, base);
  return { ...(category === undefined ? {} : { category }), ...(plugin === undefined ? {} : { plugin }),
    ...(check === undefined ? {} : { check }), ...(path === undefined ? {} : { path }), reason };
}

function validateCoverage(plugin: string | undefined, check: string | undefined,
  path: string | readonly string[] | undefined, base: string): void {
  if (check !== undefined) throw new Error(base + '/check is unavailable for coverage because coverage has no findings');
  if (plugin !== undefined && plugin !== coveragePlugin) throw new Error(base + '/plugin must be lcov for coverage');
  if (path === undefined) throw new Error(base + '/path is required for coverage to identify the files to exclude');
}

function readCategory(value: unknown, base: string): InspectionIgnoreCategory | undefined {
  if (value === undefined || value === category.maintainability || value === category.security || value === category.coverage) return value;
  throw new Error(base + '/category must be maintainability, coverage or security');
}

function readText(value: unknown, path: string, expectation: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(path + ' ' + expectation);
  return value;
}

function readPaths(value: unknown, field: string): string | readonly string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some(path => typeof path !== 'string' || /[\0\r\n]/.test(path))) {
    throw new Error(field + ' must be a glob or a nonempty list of globs');
  }
  let paths: readonly string[];
  try {
    paths = normalizeExclusions(list);
  } catch (error) {
    throw new Error(field + ' must use repository-relative globs', { cause: error });
  }
  return typeof value === 'string' ? paths[0] : paths;
}

export function recordIgnoreRules(entries: readonly FindingIgnoreRule[]): readonly RecordedFindingIgnore[] {
  return entries.map(({ category, plugin, check, path, reason }) => ({
    ...(plugin === undefined ? {} : { tool: plugin }), ...(check === undefined ? {} : { rule: check }),
    ...(path === undefined ? {} : { path }), reason, ...(category === undefined ? {} : { category }),
  }));
}

export function coverageIgnore(entries: readonly RecordedFindingIgnore[]): ((path: string) => boolean) | undefined {
  const paths = entries.filter(({ category }) => category === 'coverage').flatMap(({ path }) => path ?? []);
  return paths.length ? exclusionMatcher(paths) : undefined;
}
