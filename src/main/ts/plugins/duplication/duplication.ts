import { pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, Plugin } from '../../core/engine/plugin.js';
import { comparePaths } from '../../core/model/snapshot.js';
import { findingResult } from '../../core/model/finding.js';
import type { Finding, FindingLocation, FindingResult } from '../../core/model/finding.js';
import { definitions } from '../../core/model/measurement.js';

import { isCloneSource } from '../../core/model/clone-source.js';
import type { Candidate, CloneSource } from '../../core/model/clone-source.js';
import { duplicationSettings } from '../../core/profile/maintainability.js';

const cloneSources: DataContract<readonly CloneSource[]> = {
  id: 'repometry.clone-sources-babel/v1',
  accepts: (value): value is readonly CloneSource[] => Array.isArray(value) && value.every(isCloneSource),
};

export const duplication: Plugin = {
  id: 'duplication', version: '1.0.0', api: pluginApi,
  kinds: ['analysis'],
  produces: [{ contract: findingResult.id, persistence: 'report', metrics: [
    { id: definitions.duplicatedLines, label: 'Duplicated lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'lower',
      group: 'Maintainability' },
  ] }],
  operations: [{
    id: 'detect', role: 'inspection', inputs: { sources: cloneSources }, output: findingResult,
    execute(inputs) { return detectClones(inputs.read('sources', cloneSources)); },
  }],
};

export const duplicationInput = cloneSources;

interface Occurrence extends Candidate { readonly path: string }

function detectClones(sources: readonly CloneSource[]): FindingResult {
  const byFingerprint = new Map<string, Occurrence[]>();
  for (const { path, candidates } of sources) {
    for (const candidate of candidates) {
      const occurrences = byFingerprint.get(candidate.similar);
      const occurrence = { ...candidate, path };
      if (occurrences) occurrences.push(occurrence);
      else byFingerprint.set(candidate.similar, [occurrence]);
    }
  }
  const groups = [...byFingerprint.values()].filter(group => group.length > 1)
    .sort((left, right) => right[0]!.nodes - left[0]!.nodes || comparePaths(left[0]!.similar, right[0]!.similar));
  const matched = new Map(sources.map(source => [source.path, [] as Occurrence[]]));
  const findings: Finding[] = [];
  for (const group of groups) {
    const fresh = group.filter(occurrence => {
      const selected = matched.get(occurrence.path)!;
      const index = insertionIndex(selected, occurrence.start);
      return (selected[index - 1]?.end ?? -1) <= occurrence.start && (selected[index]?.start ?? Infinity) >= occurrence.end;
    });
    if (fresh.length < 2) continue;
    fresh.sort((left, right) => comparePaths(left.path, right.path) || left.start - right.start);
    const first = fresh[0]!;
    const identical = fresh.every(item => item.exact === first.exact);
    for (const occurrence of fresh) {
      const selected = matched.get(occurrence.path)!;
      selected.splice(insertionIndex(selected, occurrence.start), 0, occurrence);
    }
    const rule = identical ? 'identical-code' : 'similar-code';
    const effortMinutes = fresh.slice(1).reduce((total, occurrence) => total + occurrence.codeLines, 0) * duplicationSettings.minutesPerRepeatedLine;
    findings.push({ tool: 'repometry', rule, category: 'duplication', level: 'medium',
      message: `${identical ? 'Identical' : 'Similar'} code in ${fresh.length} locations`, ...location(first),
      related: fresh.slice(1).map(location), effortMinutes });
  }

  return {
    findings,
    measurements: sources.map(({ path, codeLines }) => ({ definition: definitions.duplicatedLines, target: 'file',
      path, value: matchedLineCount(codeLines, matched.get(path)!) })),
  };
}

function location({ path, line, endLine }: Occurrence): FindingLocation {
  return { path, line, endLine };
}

function insertionIndex(selected: readonly Occurrence[], start: number): number {
  let left = 0;
  let right = selected.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (selected[middle]!.start < start) left = middle + 1;
    else right = middle;
  }
  return left;
}

function matchedLineCount(codeLines: readonly number[], matches: readonly Occurrence[]): number {
  let index = 0;
  let count = 0;
  for (const line of codeLines) {
    while (index < matches.length && matches[index]!.endLine < line) index++;
    const match = matches[index];
    if (match && match.line <= line) count++;
  }
  return count;
}
