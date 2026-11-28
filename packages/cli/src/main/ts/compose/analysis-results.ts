import type { Outcome } from '@repometry/core/internal/engine/execute.js';
import type { PlannedOperation } from '@repometry/core/internal/engine/plan.js';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { ReportProducts } from '@repometry/core/internal/engine/report-products.js';
import type { Finding } from '@repometry/core/internal/model/finding.js';
import type { Measurement } from '@repometry/core/internal/model/measurement.js';
import type { StructureMeasure } from '@repometry/core/internal/model/code-structure.js';
import type { CodeStructure } from '@repometry/core/internal/model/code-structure.js';
import { codeStructure, recoveredSyntax } from '@repometry/core/internal/model/code-structure.js';
import { recoveredSourceOperation } from '@repometry/core/internal/model/report.js';
import type { Diagnostic, Report } from '@repometry/core/internal/model/report.js';

export class AnalysisResults {
  readonly measurements: Measurement[] = [];
  readonly findings: Finding[] = [];
  readonly diagnostics: Diagnostic[];
  readonly parsed = new Set<string>();
  readonly recovered = new Map<string, Diagnostic>();
  readonly ran = new Set<string>();
  readonly ruleSkips: NonNullable<Report['ruleSkips']>[number][] = [];
  readonly unmeasured = new Map<string, readonly StructureMeasure[]>();
  readonly inspected = new Set<string>();
  completedInspection = false;

  private readonly products: ReportProducts;
  private readonly scanned = new Set<string>();
  private readonly scanOnly: ReadonlySet<string>;
  private readonly securityOperations: ReadonlyMap<string, string>;
  private readonly recoveryOperations: ReadonlySet<string>;
  private readonly usedPlans = new Map<string, ReturnType<typeof operationProvenance>>();

  constructor(plugins: readonly Plugin[], oversized: readonly string[]) {
    this.products = new ReportProducts(plugins);
    this.diagnostics = oversized.map(oversizedClaim);
    this.recoveryOperations = new Set(plugins.filter(plugin => plugin.languageProvenanceRequiresSource && plugin.kinds.includes('language')).flatMap(({ id, operations }) =>
      operations.filter(operation => operation.role === 'provider' && operation.output.id === codeStructure.id)
        .map(operation => id + '/' + operation.id)));
    this.scanOnly = new Set(plugins.filter(plugin => plugin.claims?.scanOnly).flatMap(({ id, operations }) =>
      operations.map(operation => `${id}/${operation.id}`)));
    this.securityOperations = new Map(plugins.filter(plugin => plugin.kinds.includes('security')).flatMap(plugin =>
      plugin.operations.filter(({ role }) => role === 'inspection').map(({ id }) => [`${plugin.id}/${id}`, plugin.id] as const)));
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
    if (outcome.state !== 'blocked') this.ran.add(task.key);
    if (outcome.state !== 'completed') {
      this.diagnostics.push({ operation: task.key, state: outcome.state, message: outcome.reason,
        ...(path === undefined ? {} : { path }) });
      return;
    }
    try {
      const stored = this.products.record(task, outcome.product, path);
      this.recordRecovery(task, outcome.product.value, path);
      this.recordInspection(task, outcome.diagnostics ?? [], path, paths);
      if (stored) {
        for (const measurement of stored.measurements) this.measurements.push(measurement);
        for (const finding of stored.findings) this.findings.push(finding);
      }
    } catch (error) {
      this.diagnostics.push({ operation: task.key, state: 'failed', path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  hasBlockingDiagnostics(): boolean {
    return this.diagnostics.some(row => row.path === undefined || this.recovered.get(row.path) !== row);
  }

  private recordRecovery(task: PlannedOperation, value: unknown, path: string | undefined): void {
    if (path === undefined || this.recovered.has(path) || !this.recoveryOperations.has(task.key)) return;
    const facts = value as CodeStructure;
    const details = recoveryDetails(facts[recoveredSyntax]);
    if (details === undefined) return;
    const message = details.reason + ' at ' + details.location + '. Declarations omitted: ' + details.omitted + '.';
    const measured = (facts.functions ?? 0) + (facts.classes ?? 0);
    const diagnostic: Diagnostic = { operation: recoveredSourceOperation, state: 'partial', path,
      message: measured ? message : message + ' No declarations could be measured.' };
    this.recovered.set(path, diagnostic);
    this.diagnostics.push(diagnostic);
  }

  private recordInspection(task: PlannedOperation, messages: readonly { message: string; path?: string }[], path?: string,
    paths?: readonly string[]): void {
    for (const { message, path: own = path } of messages) this.diagnostics.push({ operation: task.key, state: 'partial', ...(own === undefined ? {} : { path: own }), message });
    const scanner = this.securityOperations.get(task.key);
    if (scanner) this.scanned.add(scanner);
    if (task.operation.role !== 'inspection' || (path === undefined && !paths?.length)) return;
    this.completedInspection = true;
    if (this.scanOnly.has(task.key)) return;
    if (path !== undefined) this.inspected.add(path);
    else for (const file of paths ?? []) this.inspected.add(file);
  }
}

function recoveryDetails(value: unknown) {
  if (!isRecord(value)) return undefined;
  const { reason, location, omitted } = value;
  if (typeof reason !== 'string' || !reason.trim()
    || typeof location !== 'string' || !/^line [1-9]\d*, column [1-9]\d*$/.test(location)
    || typeof omitted !== 'number' || !Number.isSafeInteger(omitted) || omitted < 0) return undefined;
  return { reason, location, omitted };
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
