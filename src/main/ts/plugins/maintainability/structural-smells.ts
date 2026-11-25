import type { StructuralObservation } from '../../core/model/code-structure.js';
import type { Finding } from '../../core/model/finding.js';
import { structuralRules } from '../../core/profile/maintainability.js';

export function structuralSmells(path: string, observations: readonly StructuralObservation[]): Finding[] {
  const findings: Finding[] = [];
  const functionLimit = structuralRules['function-complexity'].limit;
  const functionExcess = observations.reduce((total, { rule, value }) =>
    total + (rule === 'function-complexity' ? Math.max(0, value - functionLimit) : 0), 0);
  for (const { rule, value, label, line, endLine, anchor } of observations) {
    const { limit, minutesPerExcess } = structuralRules[rule];
    if (value <= limit) continue;
    const chargedExcess = rule === 'file-complexity' ? Math.max(0, value - limit - functionExcess) : value - limit;
    findings.push({ tool: 'repometry', rule, category: 'structure', level: 'medium', path,
      message: `${label} ${value} (limit ${limit})`, line, endLine, effortMinutes: chargedExcess * minutesPerExcess,
      value, limit, anchor: anchor ?? '(file)' });
  }
  return findings;
}
