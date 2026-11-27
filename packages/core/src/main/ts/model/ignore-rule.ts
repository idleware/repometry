import type { Finding } from './finding.js';

export interface FindingIgnoreRule {
  readonly tool?: string;
  readonly rule?: string;
  readonly path?: string;
  readonly reason?: string;
}

export interface IgnoredFinding {
  readonly finding: Finding;
  readonly matchedRule: number;
}
