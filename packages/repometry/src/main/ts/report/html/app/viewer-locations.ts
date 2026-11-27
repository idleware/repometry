import type { Finding } from '../../json/wire/domain-types.js';

/** Where a finding points: its primary place first, then the related ones. */
export interface Location {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

export function allLocations(finding: Finding): readonly Location[] {
  return [
    ...(finding.path ? [{ path: finding.path, line: finding.line, endLine: finding.endLine }] : []),
    ...(finding.related ?? []),
  ];
}

/** The distinct files a finding touches. */
export function locationPaths(finding: Finding): Set<string> {
  return new Set(allLocations(finding).map(location => location.path));
}

export function atPath(finding: Finding, path: string): boolean {
  return finding.path === path || (finding.related?.some(location => location.path === path) ?? false);
}

export function formatLocation(location: Location): string {
  if (location.line === undefined) return location.path;
  const end = location.endLine !== undefined && location.endLine > location.line ? `–${location.endLine}` : '';
  return `${location.path}:${location.line}${end}`;
}

/** How many findings touch each file, a finding with several places in one file counted once. */
export function findingIndex(findings: readonly Finding[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const finding of findings) for (const path of locationPaths(finding)) index.set(path, (index.get(path) ?? 0) + 1);
  return index;
}

/** The line of a file a finding points at, through its related places when its primary one is elsewhere. */
export function lineIn(finding: Finding, path: string): number | undefined {
  return finding.path === path ? finding.line : finding.related?.find(location => location.path === path)?.line;
}
