import { pluginScope } from './plugin-scope.js';
import { GitBlobHistory } from '../api/git/blob-history.js';
import type { Outcome } from '@repometry/core/internal/engine/execute.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import type { CodeStructure } from '@repometry/core/internal/model/code-structure.js';
import { debtModel } from '@repometry/core/internal/model/quality-summary.js';
import { digest, sourceDirectoriesExcluded } from '@repometry/core/internal/model/snapshot.js';
import type { SourceSnapshot } from '@repometry/core/internal/model/source.js';
import { defaultSourceExclusions, generatedSourcePolicy } from '@repometry/core/internal/profile/exclusions.js';
import { duplicationSettings, structuralRules } from '@repometry/core/internal/profile/maintainability.js';
import type { AnalysisInput } from '@repometry/core/internal/usecases/inspect.js';
import { analysisProfile } from './analysis-report.js';
import type { AnalysisSources } from './phases.js';
import type { LanguageProvider } from './languages.js';

interface FileResult {
  readonly blob: string;
  syntax?: CodeStructure;
  outcomes?: ReadonlyMap<string, Outcome>;
}

export class HistoryFiles {
  readonly current = new Map<string, FileResult>();

  constructor(private readonly ids: ReadonlyMap<string, string>, private readonly previous?: ReadonlyMap<string, FileResult>) {}

  read(path: string): FileResult | undefined {
    const result = this.previous?.get(path);
    return result?.blob === this.ids.get(path) ? result : undefined;
  }

  retain(path: string, result: Omit<FileResult, 'blob'>): void {
    const blob = this.ids.get(path);
    if (blob !== undefined) this.current.set(path, { ...this.current.get(path), ...result, blob });
  }
}

/** One range keeps at most two adjacent snapshots' results during inspection. */
export class HistoryCache {
  readonly blobs = new GitBlobHistory();
  private previous?: { readonly profile: string; readonly files: HistoryFiles };

  constructor(private readonly configuration?: unknown) {}

  begin(snapshot: SourceSnapshot, profile: string): HistoryFiles | undefined {
    if (snapshot.subject.kind !== 'commit' || snapshot.blobIds === undefined) return undefined;
    const key = digest(JSON.stringify([this.configuration, profile]));
    const files = new HistoryFiles(snapshot.blobIds, this.previous?.profile === key ? this.previous.files.current : undefined);
    this.previous = { profile: key, files };
    return files;
  }
}

export function historyProfile(input: AnalysisInput, sources: AnalysisSources, operationConfiguration?: string): string {
  return JSON.stringify([process.version, analysisProfile, input.excludedPaths, input.excludedOutput,
    sourceDirectoriesExcluded, defaultSourceExclusions, generatedSourcePolicy, structuralRules, duplicationSettings, debtModel,
    operationConfiguration, sources.plugins.map(pluginIdentity),
    sources.languages.plugins.filter(plugin => plugin.unavailableReason !== undefined).map(pluginIdentity),
    sources.languages.providers.map(({ plugin }) => sources.languages.describe(plugin).providesLanguages?.map(({ id }) => id))]);
}

function pluginIdentity(plugin: Plugin) {
  const { operations, ...manifest } = plugin;
  return { ...manifest, ...pluginScope(plugin), operations: operations.map(({ execute, inputs, output, ...operation }) => ({ ...operation,
    inputs: Object.entries(inputs).map(([port, contract]) => [port, contract.id]), output: output.id,
    implementation: operation.implementation ?? execute.toString(),
  })) };
}

export function canReuseBatch(provider: LanguageProvider): boolean {
  return provider.operation.fileIndependent === true
    && !provider.plugin.operations.some(operation => operation.scope === 'repository' && operation.role === 'inspection')
    && provider.plugin.produces.some(product => product.contract === provider.operation.output.id && product.persistence === 'transient');
}
