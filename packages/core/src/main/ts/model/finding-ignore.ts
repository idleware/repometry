import { category as inspection } from './inspection-category.js';
import { isRecord } from './plugin-data.js';
import { exclusionMatcher, normalizeExclusions } from '../profile/exclusions.js';
import type { Finding } from './finding.js';

import type { RecordedFindingIgnore, IgnoredFinding } from './ignore-rule.js';
export type { FindingIgnoreRule, IgnoredFinding } from './ignore-rule.js';

const fields = new Set(['tool', 'rule', 'path', 'reason', 'category']);
const inspectionCategory = {
  structure: inspection.maintainability, duplication: inspection.maintainability, lint: inspection.maintainability,
  security: 'security', dependency: 'security', secret: 'security', infrastructure: 'security',
} as const satisfies Record<Finding['category'], string>;

export function normalizeFindingIgnore(value: unknown): readonly RecordedFindingIgnore[] {
  if (!Array.isArray(value)) throw new Error('Recorded finding ignores must be an array');
  return value.map((item: unknown) => {
    if (!isRecord(item) || Object.entries(item).some(([key, value]) =>
      !fields.has(key) || (key === 'path' && Array.isArray(value) ? !value.length || !value.every(validText) : !validText(value)))) {
      throw new Error('Invalid recorded ignore entry');
    }
    const { tool, rule, path, reason, category } = item as RecordedFindingIgnore;
    if (category !== undefined && ![inspection.maintainability, inspection.coverage, inspection.security].includes(category)) {
      throw new Error('Invalid recorded ignore category');
    }
    if (tool === undefined && rule === undefined && path === undefined && category === undefined) {
      throw new Error('A recorded finding ignore needs at least one plugin, check, path or category selector');
    }
    return { ...(tool !== undefined && { tool }), ...(rule !== undefined && { rule }),
      ...(path !== undefined && { path: typeof path === 'string' ? normalizeExclusions([path])[0]! : normalizeExclusions(path) }), ...(reason !== undefined && { reason }), ...(category !== undefined && { category }) };
  });
}

function validText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !/[\0\r\n]/.test(value);
}

export function partitionFindings(items: readonly Finding[], ignore: readonly RecordedFindingIgnore[]):
  { findings: readonly Finding[]; ignoredFindings: readonly IgnoredFinding[] } {
  const findings: Finding[] = [];
  const ignoredFindings: IgnoredFinding[] = [];
  const matches = ignore.map(({ tool, rule, path, category }) => {
    const matchesPath = path === undefined ? undefined : exclusionMatcher(typeof path === 'string' ? [path] : path);
    return (item: Finding) => (tool === undefined || tool === item.tool) && (rule === undefined || rule === item.rule)
      && (category === undefined || inspectionCategory[item.category] === category)
      && (matchesPath === undefined || (item.path !== undefined && matchesPath(item.path)));
  });
  for (const finding of items) {
    const matchedRule = matches.findIndex(match => match(finding));
    if (matchedRule < 0) findings.push(finding);
    else ignoredFindings.push({ finding, matchedRule });
  }
  return { findings, ignoredFindings };
}
