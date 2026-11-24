import type { Outcome } from '../core/engine/execute.js';
import type { PlannedOperation } from '../core/engine/plan.js';
import type { Plugin } from '../core/engine/plugin.js';
import { ReportProducts } from '../core/engine/report-products.js';
import type { Finding } from '../core/model/finding.js';
import type { Measurement } from '../core/model/measurement.js';
import type { StructureMeasure } from '../core/model/code-structure.js';
import type { Diagnostic, Report } from '../core/model/report.js';
import { inspectionKeys } from './analysis-sources.js';

export class AnalysisResults {
  readonly measurements: Measurement[] = [];
  readonly findings: Finding[] = [];
  readonly diagnostics: Diagnostic[];
  readonly parsed = new Set<string>();
  readonly ruleSkips: NonNullable<Report['ruleSkips']>[number][] = [];
  readonly unmeasured = new Map<string, readonly StructureMeasure[]>();
  readonly inspected = new Set<string>();
  completedInspection = false;

  private readonly products: ReportProducts;
  private readonly scanned = new Set<string>();
  private readonly scanOnly: ReadonlySet<string>;
  private readonly securityOperations: ReadonlyMap<string, string>;
  private readonly usedPlans = new Map<string, ReturnType<typeof operationProvenance>>();

  constructor(plugins: readonly Plugin[], claimed: readonly Plugin[], oversized: readonly string[]) {
    this.products = new ReportProducts(plugins);
    this.diagnostics = oversized.map(oversizedClaim);
    this.scanOnly = new Set(plugins.filter(plugin => plugin.claims?.scanOnly).flatMap(({ id, operations }) =>
      operations.map(operation => `${id}/${operation.id}`)));
    this.securityOperations = new Map(claimed.filter(plugin => plugin.kinds.includes('security')).flatMap(plugin =>
      inspectionKeys(plugin).map(key => [key, plugin.id] as const)));
  }

  remember(task: PlannedOperation, syntaxProvider?: string): void {
    this.usedPlans.set(JSON.stringify([task.key, [...task.inputs], syntaxProvider]), operationProvenance(task, syntaxProvider));
  }

  operationRecords(): readonly ReturnType<typeof operationProvenance>[] {
    return [...this.usedPlans.values()];
  }

  pluginData() {
    return this.products.result();
  }

  securityScanners(plugins: readonly Plugin[]) {
    return plugins.filter(plugin => this.scanned.has(plugin.id)).map(({ id, version }) => ({ name: id, version }));
  }

  record(task: PlannedOperation, outcome: Outcome, path?: string, paths?: readonly string[]): void {
    if (outcome.state !== 'completed') {
      this.diagnostics.push({ operation: task.key, state: outcome.state, message: outcome.reason,
        ...(path === undefined ? {} : { path }) });
      return;
    }
    try {
      const stored = this.products.record(task, outcome.product, path);
      this.recordInspection(task, outcome.diagnostics ?? [], path, paths);
      if (stored) {
        this.measurements.push(...stored.measurements);
        this.findings.push(...stored.findings);
      }
    } catch (error) {
      this.diagnostics.push({ operation: task.key, state: 'failed', path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private recordInspection(task: PlannedOperation, messages: readonly string[], path?: string, paths?: readonly string[]): void {
    for (const message of messages) this.diagnostics.push({ operation: task.key, state: 'partial', message,
      ...(path === undefined ? {} : { path }) });
    const scanner = this.securityOperations.get(task.key);
    if (scanner) this.scanned.add(scanner);
    if (task.operation.role !== 'inspection' || (path === undefined && !paths?.length)) return;
    this.completedInspection = true;
    if (this.scanOnly.has(task.key)) return;
    if (path !== undefined) this.inspected.add(path);
    else for (const file of paths ?? []) this.inspected.add(file);
  }
}

export function operationProvenance(task: PlannedOperation, syntaxProvider?: string) {
  return { key: task.key, inputs: Object.fromEntries(task.inputs),
    ...(task.operation.implementation === undefined ? {} : { implementation: task.operation.implementation }),
    ...(task.operation.scope === 'repository' ? { scope: task.operation.scope } : {}),
    ...(syntaxProvider === undefined ? {} : { syntaxProvider }) };
}

export function oversizedClaim(path: string): Diagnostic {
  return { operation: 'source/claims', state: 'partial', path, message: 'Plugin inspection skipped a file larger than 1 MiB' };
}
