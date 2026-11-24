import type { Measurement } from './measurement.js';
import type { Finding } from './finding.js';
import type { IgnoredFinding } from './ignore-rule.js';
import { isRecord } from './plugin-data.js';
import type { PluginData } from './plugin-data.js';
import type { Subject } from './source.js';

export const reportSchema = 'urn:repometry:schema:report:2';

export interface Diagnostic {
  readonly operation: string;
  readonly state: 'failed' | 'blocked' | 'partial';
  readonly message: string;
  readonly path?: string;
}

export interface Report {
  readonly schema: typeof reportSchema;
  readonly subject: Subject;
  readonly generatedAt: string;
  readonly committedAt?: string;
  /** The inspected commit's message title and author, recorded at analysis so the store alone can describe it. */
  readonly commit?: { readonly subject: string; readonly author: { readonly name: string; readonly email: string } };
  readonly appliedConfig: Readonly<Record<string, unknown>>;
  readonly definitions: Readonly<Record<string, string>>;
  readonly scope: { readonly files: number; readonly parsed: number };
  readonly status: 'complete' | 'partial' | 'not-applicable';
  readonly measurements: readonly Measurement[];
  readonly diagnostics: readonly Diagnostic[];
  readonly findings?: readonly Finding[];
  readonly ruleSkips?: readonly { readonly path: string; readonly plugin: string; readonly rules: readonly string[]; readonly reason: 'unmeasured' }[];
  readonly ignoredFindings?: readonly IgnoredFinding[];
  readonly pluginData?: PluginData;
}

export function validSubjectId(kind: Subject['kind'], id: string): boolean {
  return /^[a-f0-9]{64}$/.test(id) || (kind === 'commit' && /^[a-f0-9]{40}$/.test(id));
}

export const legacySyntaxPlugin = 'babel-syntax';

// Keep history comparable when the parser starts recording its own tool versions.
export function historicalPluginTools(plugins: unknown): unknown {
  if (!Array.isArray(plugins)) return plugins;
  const syntax = plugins.find(entry => isRecord(entry) && entry.id === legacySyntaxPlugin);
  if (!isRecord(syntax?.tools)) return plugins;
  const { '@babel/types': types, ...native } = syntax.tools;
  if (typeof types !== 'string') return plugins;
  return plugins.map(entry => {
    if (entry === syntax) return { ...syntax, tools: native };
    if (!isRecord(entry) || (entry.id !== 'structure' && entry.id !== 'maintainability') || !isRecord(entry.tools)) return entry;
    return { ...entry, tools: { '@babel/types': types, ...entry.tools } };
  });
}
