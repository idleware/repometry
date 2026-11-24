import { isRecord } from './plugin.js';
import type { MetricDescriptor, Plugin, ProductDeclaration, RuleDescriptor } from './plugin.js';
import { definitions } from '../model/measurement.js';
import { isLanguageDisplay } from '../model/language.js';

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

export function manifestProducts(plugin: Plugin): ReadonlyMap<string, ProductDeclaration> {
  const { id, produces, rules } = manifestDeclarations(plugin);
  const products = new Map<string, ProductDeclaration>();
  const catalog = new Map<string, MetricDescriptor>();
  for (const product of produces) {
    if (!isRecord(product) || !text(product.contract) || !text(product.persistence) || !persistence.has(product.persistence)
      || products.has(product.contract)) throw new Error(`Invalid or duplicate product for plugin ${id}`);
    const { contract, schema, metrics } = product;
    if (schema === undefined ? product.persistence !== 'transient' && !isCoreReportProduct(contract)
      : typeof schema !== 'boolean' && !isRecord(schema)) {
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
  const undeclared = rules?.find(rule => rule.measure !== undefined && !catalog.has(rule.measure));
  if (undeclared) throw new Error(`Rule ${undeclared.id} in plugin ${id} references undeclared metric ${undeclared.measure}`);
  for (const metric of catalog.values()) {
    if (!metric.ratio) continue;
    const invalid = [metric.ratio.of, metric.ratio.over].find(component =>
      component === metric.id || (!catalog.has(component) && !coreMetrics.has(component)));
    if (invalid !== undefined) throw new Error(`Ratio ${metric.id} in plugin ${id} references invalid component ${invalid}`);
  }
  return products;
}

function manifestDeclarations(plugin: Plugin) {
  const { id, kinds: declaredKinds, claims, providesLanguages, produces, rules, config } = plugin;
  if (declaredKinds === undefined && claims === undefined && providesLanguages === undefined && produces === undefined) {
    throw new Error(`Missing plugin manifest for ${id}. Declare kinds and produces.`);
  }
  if (Object.hasOwn(plugin, 'languages')) throw new Error(`Plugin ${id} must declare languages in claims.languages`);
  if (!strings(declaredKinds) || declaredKinds.length === 0 || declaredKinds.some(kind => !kinds.has(kind))) {
    throw new Error(`Invalid kinds for plugin ${id}`);
  }
  if (claims !== undefined && (!isRecord(claims) || Object.entries(claims).some(([key, values]) =>
    key === 'scanOnly' ? typeof values !== 'boolean'
    : !['extensions', 'globs', 'languages'].includes(key) || !strings(values)
    || (key === 'extensions' && !values.every(isExtension))))) {
    throw new Error(`Invalid file claims for plugin ${id}`);
  }
  if (providesLanguages !== undefined && (!declaredKinds.includes('language') || !validLanguages(providesLanguages))) {
    throw new Error(`Invalid provided languages for plugin ${id}`);
  }
  if (!Array.isArray(produces)) throw new Error(`Plugin ${id} must declare its products`);
  if (rules !== undefined && (!Array.isArray(rules) || !rules.every(isRuleDescriptor)
    || new Set(rules.map(rule => rule.id)).size !== rules.length)) throw new Error(`Invalid or duplicate rules for plugin ${id}`);
  if (config !== undefined && typeof config !== 'boolean' && !isRecord(config)) throw new Error(`Invalid configuration schema for plugin ${id}`);
  return { id, produces, rules };
}

function validLanguages(values: unknown): boolean {
  if (!Array.isArray(values) || values.length === 0) return false;
  const ids = new Set<string>();
  for (const value of values as unknown[]) {
    if (!isRecord(value) || !isLanguageDisplay(value) || ids.has(value.id)) return false;
    const { extensions, globs } = value;
    if (extensions !== undefined && (!strings(extensions) || !extensions.every(isExtension))) return false;
    if (globs !== undefined && !strings(globs)) return false;
    if (!(Array.isArray(extensions) && extensions.length || Array.isArray(globs) && globs.length)) return false;
    ids.add(value.id);
  }
  return true;
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

function isExtension(value: string): boolean {
  return /^\.[\w-]+$/.test(value);
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
