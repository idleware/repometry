import type { MetricDescriptor } from '../model/metric-descriptor.js';
import type { ProvidedLanguage } from '../model/language.js';
import type { JsonValue } from '../model/plugin-data.js';
export type { MetricDescriptor, MetricScope } from '../model/metric-descriptor.js';
export { isRecord } from '../model/plugin-data.js';

export const pluginApi = 'repometry.plugin/v1';

export interface DataContract<T = unknown> {
  readonly id: string;
  readonly accepts: (value: unknown) => value is T;
}

export interface Product {
  readonly contract: string;
  readonly value: unknown;
}

export interface InspectionInputs {
  read<T>(port: string, contract: DataContract<T>): T;
  emitDiagnostic?(message: string, path?: string): void;
}

export interface Operation {
  readonly id: string;
  readonly role: 'provider' | 'inspection';
  readonly scope?: 'file' | 'repository';
  /** A repository provider produces the same results and diagnostics for each file regardless of which siblings it receives. */
  readonly fileIndependent?: boolean;
  readonly inputs: Readonly<Record<string, DataContract>>;
  readonly output: DataContract;
  /** Fingerprint for executable details that the declared versions and inputs do not carry. */
  readonly implementation?: string;
  execute(inputs: InspectionInputs): unknown | Promise<unknown>;
}

export interface RuleDescriptor {
  readonly id: string;
  readonly category: string;
  readonly description?: string;
  readonly defaults?: { readonly limit?: number; readonly cost?: number };
  readonly measure?: string;
  readonly per?: readonly [singular: string, plural: string];
}

export type PluginConfigSchema = boolean | Readonly<Record<string, unknown>>;

export type PluginKind = 'language' | 'analysis' | 'coverage' | 'security' | 'import' | 'source';

export interface FileClaims {
  readonly extensions?: readonly string[];
  readonly globs?: readonly string[];
  readonly languages?: readonly string[];
  /** Run inspections for matching files without counting them as analysed in the inventory. */
  readonly scanOnly?: boolean;
}

export interface ProductDeclaration {
  readonly contract: string;
  readonly persistence: 'report' | 'cache' | 'transient';
  readonly schema?: PluginConfigSchema;
  readonly metrics?: readonly MetricDescriptor[];
}

export interface Plugin {
  readonly id: string;
  readonly version: string;
  readonly api: string;
  readonly tools?: Readonly<Record<string, string>>;
  readonly operations: readonly Operation[];
  readonly rules?: readonly RuleDescriptor[];
  readonly config?: PluginConfigSchema;
  /** Effective non-secret settings saved with inspection provenance. */
  readonly settings?: JsonValue;
  readonly kinds: readonly PluginKind[];
  readonly claims?: FileClaims;
  readonly providesLanguages?: readonly ProvidedLanguage[];
  /** Publish parser selectors and display metadata only when a snapshot contains its files. */
  readonly languageProvenanceRequiresSource?: true;
  readonly produces: readonly ProductDeclaration[];
}
