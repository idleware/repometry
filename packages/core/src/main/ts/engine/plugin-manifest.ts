import type { LanguageDisplay, LanguageSyntax } from '../model/language.js';
import type { StructureMeasure } from '../model/code-structure.js';
import { category } from '../model/inspection-category.js';
import type { PluginCategory } from '../model/inspection-category.js';
import type { JsonValue } from '../model/plugin-data.js';
import type { Operation, Plugin, ProductDeclaration, RuleDescriptor } from './plugin.js';

export const pluginManifestSchema = 'urn:repometry:schema:plugin:1';

export type { PluginCategory } from '../model/inspection-category.js';
type Language = LanguageDisplay & {
  readonly include: readonly string[];
  readonly syntax?: LanguageSyntax;
  readonly measures?: readonly (Exclude<StructureMeasure, 'structuralRules'> | 'checks')[];
};

export type Check = Omit<RuleDescriptor, 'category'>;
export type ProductOutput = Omit<ProductDeclaration, 'schema'> & {
  readonly valueSchema?: boolean | Readonly<Record<string, unknown>>;
};

export interface PluginManifest<Options = JsonValue> {
  readonly schema: typeof pluginManifestSchema;
  readonly id: string;
  readonly category: PluginCategory;
  readonly version?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly languages?: readonly Language[];
  readonly optionsSchema?: boolean | Readonly<Record<string, unknown>>;
  readonly requires?: {
    readonly node?: string;
    readonly repometry?: string;
    readonly tools?: readonly string[];
  };
  readonly checks?: readonly Check[];
  create(options: Options | undefined, context: { readonly root: string }):
    PluginOperations | Promise<PluginOperations>;
}

interface PluginOperations {
  readonly operations: readonly Operation[];
  readonly produces: readonly ProductOutput[];
}

export function pluginCategory(plugin: Plugin): PluginCategory {
  const categories = [category.language, category.source, category.security, category.coverage];
  return categories.find(value => plugin.kinds.includes(value)) ?? category.maintainability;
}
