import { isDeepStrictEqual } from 'node:util';
import { findingResult } from '../model/finding.js';
import type { FindingResult } from '../model/finding.js';
import { measurements } from '../model/measurement.js';
import { isJsonValue } from '../model/plugin-data.js';
import type { PersistedProduct, PluginData } from '../model/plugin-data.js';
import { isRecord } from './plugin.js';
import type { MetricDescriptor, Plugin, PluginConfigSchema, Product } from './plugin.js';
import type { PlannedOperation } from './plan.js';

export class ReportProducts {
  private readonly metrics = new Map<string, MetricDescriptor>();
  private readonly measured = new Set<string>();
  private readonly alwaysReport = new Set<string>();
  private readonly privateMetrics = new Set<string>();
  private readonly products = new Map<string, PersistedProduct[]>();
  private readonly contracts = new Map<string, PluginConfigSchema>();
  private readonly rules: PluginData['rules'];
  private readonly declared: boolean;

  constructor(plugins: readonly Plugin[]) {
    this.declared = plugins.some(plugin => plugin.produces !== undefined);
    this.rules = plugins.flatMap(({ id, rules }) => rules?.length ? [{ plugin: id, rules }] : []);
    for (const plugin of plugins) {
      for (const product of plugin.produces ?? []) {
        if (product.persistence !== 'report') continue;
        if (product.schema !== undefined) {
          const previous = this.contracts.get(product.contract);
          if (previous !== undefined && !isDeepStrictEqual(previous, product.schema)) {
            throw new Error(`Conflicting product schemas: ${product.contract}`);
          }
          this.contracts.set(product.contract, product.schema);
        }
        for (const metric of product.metrics ?? []) this.registerMetric(plugin, metric);
      }
    }
  }

  private registerMetric(plugin: Plugin, metric: MetricDescriptor): void {
    const existing = this.metrics.get(metric.id);
    if (existing && !isDeepStrictEqual(existing, metric)) throw new Error(`Conflicting metric declaration: ${metric.id}`);
    this.metrics.set(metric.id, metric);
    if (!plugin.languageProvenanceRequiresSource) this.alwaysReport.add(metric.id);
    if (plugin.kinds?.includes('security')) this.privateMetrics.add(metric.id);
  }

  record(task: PlannedOperation, { contract, value }: Product, path?: string): FindingResult | undefined {
    if (task.declaration?.persistence !== 'report') return undefined;
    const rows = measurements.accepts(value) ? { measurements: value, findings: [] }
      : findingResult.accepts(value) ? value
      : isRecord(value) && measurements.accepts(value.measurements) ? { measurements: value.measurements, findings: [] } : undefined;
    if (rows) {
      const declared = new Set(task.declaration.metrics?.map(metric => metric.id));
      const unknown = rows.measurements.find(row => !declared.has(row.definition));
      if (unknown) throw new Error(`Undeclared metric from ${task.key}: ${unknown.definition}`);
    }
    if (task.declaration.schema === undefined && !rows) throw new Error(`Report product ${contract} from ${task.key} has no schema and no rows`);
    if (task.declaration.schema !== undefined) {
      if (!isJsonValue(value)) throw new Error(`Report product ${contract} is not JSON data`);
      const record = { operation: task.key, ...(path === undefined ? {} : { path }), value };
      const existing = this.products.get(contract);
      if (existing) existing.push(record);
      else this.products.set(contract, [record]);
    }
    for (const metric of task.declaration.metrics ?? []) this.measured.add(metric.id);
    return rows;
  }

  result(): PluginData | undefined {
    if (!this.declared) return undefined;
    const visible = (id: string) => this.alwaysReport.has(id) || this.measured.has(id);
    const metrics = [...this.metrics.values()].filter(({ id }) => visible(id));
    const privateMetrics = [...this.privateMetrics].filter(visible);
    return { metrics, measured: [...this.measured],
      ...(privateMetrics.length ? { privateMetrics } : {}),
      ...(this.contracts.size ? { contracts: Object.fromEntries(this.contracts) } : {}),
      rules: this.rules, products: Object.fromEntries(this.products) };
  }
}
