import { isRecord } from './plugin.js';
import type { LegacyPlugin, MetricDescriptor, Plugin, ProductDeclaration, RuleDescriptor } from './plugin.js';
import { definitions } from '../model/measurement.js';

const kinds = new Set(['language', 'analysis', 'coverage', 'security', 'import', 'source']);
const persistence = new Set(['report', 'cache', 'transient']);
const units = new Set(['count', 'ratio', 'minutes']);
const scopes = new Set(['repository', 'file', 'function']);
const aggregates = new Set(['sum', 'max', 'none']);
const directions = new Set(['lower', 'higher', 'none']);
const coreMetrics = new Set<string>(Object.values(definitions));
const coreProducts = new Set([
  'repometry.measurements/v1', 'repometry.findings-and-measurements/v1',
  'repometry.maintainability-file/v1', 'repometry.coverage-result/v1',
  'repometry.source-locator/v1',
]);

export function isCoreReportProduct(contract: string): boolean {
  return coreProducts.has(contract);
}

export function manifestProducts(plugin: Plugin | LegacyPlugin, allowLegacy: boolean): ReadonlyMap<string, ProductDeclaration> | undefined {
  const { id, kinds: declaredKinds, claims, produces, rules, config } = plugin as Partial<Plugin> & LegacyPlugin;
  if (declaredKinds === undefined && claims === undefined && produces === undefined) {
    if (allowLegacy) return undefined;
    throw new Error(`Missing plugin manifest for ${id}. Declare kinds and produces.`);
  }
  if (Object.hasOwn(plugin, 'languages')) throw new Error(`Plugin ${id} must declare languages in claims.languages`);
  if (!strings(declaredKinds) || declaredKinds.length === 0 || declaredKinds.some(kind => !kinds.has(kind))) {
    throw new Error(`Invalid kinds for plugin ${id}`);
  }
  if (claims !== undefined && (!isRecord(claims) || Object.entries(claims).some(([key, values]) =>
    key === 'scanOnly' ? typeof values !== 'boolean'
    : !['extensions', 'globs', 'languages'].includes(key) || !strings(values)
    || (key === 'extensions' && values.some(extension => !/^\.[\w-]+$/.test(extension)))))) {
    throw new Error(`Invalid file claims for plugin ${id}`);
  }
  if (!Array.isArray(produces)) throw new Error(`Plugin ${id} must declare its products`);
  if (rules !== undefined && (!Array.isArray(rules) || !rules.every(isRuleDescriptor)
    || new Set(rules.map(rule => rule.id)).size !== rules.length)) throw new Error(`Invalid or duplicate rules for plugin ${id}`);
  if (config !== undefined && typeof config !== 'boolean' && !isRecord(config)) throw new Error(`Invalid configuration schema for plugin ${id}`);

  const products = new Map<string, ProductDeclaration>();
  const catalog = new Map<string, MetricDescriptor>();
  for (const product of produces) {
    if (!isRecord(product) || !text(product.contract) || !text(product.persistence) || !persistence.has(product.persistence)
      || products.has(product.contract)) throw new Error(`Invalid or duplicate product for plugin ${id}`);
    const { contract, schema, metrics } = product;
    if ((schema === undefined && product.persistence !== 'transient' && !isCoreReportProduct(contract))
      || (schema !== undefined && typeof schema !== 'boolean' && !isRecord(schema))) {
      throw new Error(`Missing or invalid product schema for ${contract} in plugin ${id}`);
    }
    if (metrics !== undefined && (!Array.isArray(metrics) || !metrics.every(isMetricDescriptor))) {
      throw new Error(`Invalid metric descriptors for ${contract} in plugin ${id}`);
    }
    const declaration = product as unknown as ProductDeclaration;
    for (const metric of declaration.metrics ?? []) {
      if (catalog.has(metric.id)) throw new Error(`Duplicate metric ${metric.id} in plugin ${id}`);
      catalog.set(metric.id, metric);
    }
    products.set(contract, declaration);
  }
  for (const rule of rules ?? []) {
    if (rule.measure !== undefined && !catalog.has(rule.measure)) {
      throw new Error(`Rule ${rule.id} in plugin ${id} references undeclared metric ${rule.measure}`);
    }
  }
  for (const metric of catalog.values()) {
    if (!metric.ratio) continue;
    for (const component of [metric.ratio.of, metric.ratio.over]) {
      if (component === metric.id || (!catalog.has(component) && !coreMetrics.has(component))) {
        throw new Error(`Ratio ${metric.id} in plugin ${id} references invalid component ${component}`);
      }
    }
  }
  return products;
}

function isRuleDescriptor(value: unknown): value is RuleDescriptor {
  return isRecord(value) && text(value.id) && text(value.category) && optionalText(value.description)
    && optionalText(value.measure) && (value.per === undefined || (Array.isArray(value.per) && value.per.length === 2 && value.per.every(text)))
    && (value.defaults === undefined || (isRecord(value.defaults)
      && Object.entries(value.defaults).every(([key, amount]) => (key === 'limit' || key === 'cost')
        && (amount === undefined || (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)))));
}

export function isMetricDescriptor(value: unknown): value is MetricDescriptor {
  return isRecord(value) && text(value.id) && text(value.label)
    && text(value.unit) && units.has(value.unit) && text(value.scope) && scopes.has(value.scope)
    && text(value.aggregate) && aggregates.has(value.aggregate) && text(value.better) && directions.has(value.better)
    && optionalText(value.short) && optionalText(value.description) && optionalText(value.group)
    && (value.ratio === undefined || (value.unit === 'ratio' && isRecord(value.ratio) && text(value.ratio.of) && text(value.ratio.over)))
    && (value.bands === undefined || (Array.isArray(value.bands) && value.bands.length === 4
      && value.bands.every((limit, index, array) => typeof limit === 'number' && Number.isFinite(limit)
        && (index === 0 || limit > array[index - 1]))));
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalText(value: unknown): boolean {
  return value === undefined || text(value);
}
