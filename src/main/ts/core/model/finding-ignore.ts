import { isRecord } from './plugin-data.js';
import { exclusionMatcher, normalizeExclusions } from '../profile/exclusions.js';
import type { Finding } from './finding.js';

import type { FindingIgnoreRule, IgnoredFinding } from './ignore-rule.js';
export type { FindingIgnoreRule, IgnoredFinding } from './ignore-rule.js';

const fields = new Set(['tool', 'rule', 'path', 'reason']);

export function normalizeFindingIgnore(value: unknown): readonly FindingIgnoreRule[] {
  if (!Array.isArray(value)) throw new Error('Profile ignore must be an array of finding rules');
  return value.map((item: unknown) => {
    if (!isRecord(item) || Object.entries(item).some(([key, value]) =>
      !fields.has(key) || typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/.test(value))) {
      throw new Error('Finding ignore rules accept tool, rule, path and reason strings');
    }
    const { tool, rule, path, reason } = item as FindingIgnoreRule;
    if (tool === undefined && rule === undefined && path === undefined) {
      throw new Error('Choose at least one of tool, rule or path for a finding ignore rule');
    }
    return { ...(tool !== undefined && { tool }), ...(rule !== undefined && { rule }),
      ...(path !== undefined && { path: normalizeExclusions([path])[0]! }), ...(reason !== undefined && { reason }) };
  });
}

export function partitionFindings(items: readonly Finding[], ignore: readonly FindingIgnoreRule[]):
  { findings: readonly Finding[]; ignoredFindings: readonly IgnoredFinding[] } {
  const findings: Finding[] = [];
  const ignoredFindings: IgnoredFinding[] = [];
  const matches = ignore.map(({ tool, rule, path }) => {
    const matchesPath = path === undefined ? undefined : exclusionMatcher([path]);
    return (item: Finding) => (tool === undefined || tool === item.tool) && (rule === undefined || rule === item.rule)
      && (matchesPath === undefined || (item.path !== undefined && matchesPath(item.path)));
  });
  for (const finding of items) {
    const matchedRule = matches.findIndex(match => match(finding));
    if (matchedRule < 0) findings.push(finding);
    else ignoredFindings.push({ finding, matchedRule });
  }
  return { findings, ignoredFindings };
}
