import type { DataContract, Operation, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { changesInput } from '@repometry/core/internal/model/changes.js';
import { cloneSources } from '@repometry/core/internal/model/clone-source.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';
import { lcovInput } from '@repometry/core/internal/model/coverage-input.js';
import { sourceFile, sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import type { SourceFile, SourceSnapshot } from '@repometry/core/internal/model/source.js';
import { builtInPluginIds } from './built-ins.js';
import { claimMatcher } from './languages.js';
import type { LanguageProvider, LanguageRegistry } from './languages.js';
import { inspectionClaims } from './parser-order.js';

/**
 * A phase of a run: the host inputs it offers by external port name, and what one of its tasks covers: one file, the files
 * one plugin claims, or the whole run once. An operation runs only where the task matches its scope; a run task takes any.
 */
export type Phase = Readonly<{ offers: Readonly<Record<string, DataContract>>; task: 'file' | 'repository' | 'run' }>;

/** The phases of an analysis in run order. The coverage input is offered only when coverage is given. */
export function analysisPhases(withCoverage: boolean) {
  return {
    files: { task: 'file', offers: { file: sourceFile, syntax: codeStructure } },
    repository: { task: 'repository', offers: { files: sourceFiles } },
    afterFiles: { task: 'run', offers: { sources: cloneSources, ...(withCoverage ? { lcov: lcovInput } : {}) } },
  } as const satisfies Record<string, Phase>;
}

/** The one phase of a diff coverage run. */
export const diffCoveragePhases = { changedLines: { task: 'run', offers: { changes: changesInput, lcov: lcovInput } } } as const;

/** The phases of each kind of run, with all their optional host inputs. Every plugin takes part in an analysis; only built-ins in diff coverage. */
const analysisRun: readonly Phase[] = Object.values(analysisPhases(true));
const diffCoverageRun: readonly Phase[] = Object.values(diffCoveragePhases);

/** The closed list of host contracts: every contract some host run offers. */
const hostContracts = new Set([...analysisRun, ...diffCoverageRun].flatMap(({ offers }) => Object.values(offers).map(({ id }) => id)));
// Reserve both parse outputs. The host supplies per-file structure directly to phases.
const languageOutputs = new Set([codeStructure.id, codeStructures.id]);

export type ActiveOperation = Readonly<{ plugin: Plugin; operation: Operation; key: string }>;

/**
 * The one rule for every plugin. An input is satisfied in a phase by a host input the phase offers, or by the output of
 * any operation satisfied in that phase; more than one candidate is the planner's ambiguity. An operation runs in the
 * first phase of this run that satisfies all its inputs. One that no phase of any run satisfies is an error; one that
 * only another run, or this run with coverage, satisfies is inactive here. Host contracts come from the host only: no
 * operation outputs one, except the parse of a language provider (`parsers`, by key), which is how the host gets it.
 */
export function selectOperations<Name extends string>(plugins: readonly Plugin[], phases: Readonly<Record<Name, Phase>>,
  parsers: ReadonlySet<string>) {
  const all = plugins.flatMap(plugin => plugin.operations.map(operation => ({ plugin, operation, key: `${plugin.id}/${operation.id}` })));
  const supplier = all.find(({ key, operation: { output } }) =>
    (hostContracts.has(output.id) || languageOutputs.has(output.id)) && !parsers.has(key));
  if (supplier) {
    const { id } = supplier.operation.output;
    const only = languageOutputs.has(id) ? 'a language provider' : 'the host';
    throw new Error(`${supplier.key} outputs ${id}, which only ${only} supplies`);
  }
  rejectUnsatisfiable(all);
  const selected = {} as Record<Name, ActiveOperation[]>;
  let waiting = all;
  for (const [name, phase] of Object.entries<Phase>(phases) as [Name, Phase][]) {
    selected[name] = satisfiedIn(phase, waiting);
    waiting = waiting.filter(candidate => !selected[name].includes(candidate));
  }
  return selected;
}

/** The operations a phase satisfies: those of its task's scope whose inputs it offers or satisfied operations output. */
function satisfiedIn(phase: Phase, candidates: readonly ActiveOperation[]): ActiveOperation[] {
  const inScope = candidates.filter(({ operation }) => [operation.scope ?? 'file', 'run'].includes(phase.task));
  return reached(inScope, Object.values(phase.offers).map(({ id }) => id), 'every');
}

/** The operations reached from some contracts: each reads every (or some) of its inputs from them or from earlier ones' outputs. */
function reached(operations: readonly ActiveOperation[], contracts: readonly string[], reads: 'every' | 'some',
  found: readonly ActiveOperation[] = []): ActiveOperation[] {
  const next = operations.filter(item => !found.includes(item) && Object.values(item.operation.inputs)[reads](({ id }) => contracts.includes(id)));
  if (!next.length) return operations.filter(item => found.includes(item));
  return reached(operations, [...contracts, ...next.map(({ operation }) => operation.output.id)], reads, [...found, ...next]);
}

/** Rejects an operation that no phase satisfies in any run its plugin takes part in, naming the root cause first. */
function rejectUnsatisfiable(all: readonly ActiveOperation[]): void {
  const satisfiable = new Set([...analysisRun.flatMap(phase => satisfiedIn(phase, all)),
    ...diffCoverageRun.flatMap(phase => satisfiedIn(phase, all.filter(({ plugin }) => builtInPluginIds.has(plugin.id))))]);
  const unsatisfiable = all.filter(candidate => !satisfiable.has(candidate));
  const ids = (contracts: Iterable<{ id: string }>) => [...contracts].map(({ id }) => id);
  const known = [...hostContracts, ...ids(all.map(({ operation }) => operation.output))];
  const reachable = [...hostContracts, ...ids([...satisfiable].map(({ operation }) => operation.output))];
  const unread = ({ operation }: ActiveOperation, offered: readonly string[]) => ids(Object.values(operation.inputs)).filter(id => !offered.includes(id));
  const unknown = unsatisfiable.find(candidate => unread(candidate, known).length);
  if (unknown) throw new Error(`${unknown.key} reads ${unread(unknown, known).join(', ')}, which no plugin outputs`);
  // The root cause before what depends on it: an operation whose inputs are all on offer, but in no single phase.
  const root = unsatisfiable.find(candidate => !unread(candidate, reachable).length);
  if (root) throw new Error(`${root.key} reads ${ids(Object.values(root.operation.inputs)).join(', ')}, which no phase of its runs offers together`);
  // What is left reads only the products of unsatisfiable operations, as in a dependency cycle.
  const [dependent] = unsatisfiable;
  if (dependent) throw new Error(`${dependent.key} reads ${unread(dependent, reachable).join(', ')}, which only operations that never run output`);
}

/** An active inspection and the files it runs on: those its plugin claims, and only parsed ones when it reads code structure. */
export type Inspection = ActiveOperation & { readonly parsed: boolean; readonly matches: (path: string, parsed: boolean) => boolean };

/** One step of the pipeline: the plugins the planner may choose from, and the inspections to plan. */
export type Step = Readonly<{ candidates: readonly Plugin[]; inspections: readonly Inspection[] }>;

/** What runs where in an analysis: the active plugins and the four steps. */
function analysisSteps(plugins: readonly Plugin[], languages: LanguageRegistry, withCoverage: boolean) {
  const { files, repository, afterFiles } = selectOperations(plugins, analysisPhases(withCoverage), new Set(languages.providers.map(({ key }) => key)));
  // Those that read the code structure, directly or through the products of others, run on the parsed files their plugin claims.
  const readers = new Set(reached(files, [codeStructure.id], 'some'));
  const claims = new Map(plugins.map(plugin => [plugin.id, claimsOf(plugin, languages)]));
  const step = (operations: readonly ActiveOperation[]): Step => ({ candidates: candidatesOf(operations),
    inspections: operations.filter(({ operation }) => operation.role === 'inspection').map(active => ({ ...active, parsed: readers.has(active),
      matches: (path: string, isParsed: boolean) => (!readers.has(active) || isParsed) && claims.get(active.plugin.id)!(path) })) });
  const parsers = repositoryParsers(plugins, languages);
  const active = new Set([...files, ...repository, ...afterFiles].map(({ plugin }) => plugin));
  return {
    plugins: plugins.filter(plugin => active.has(plugin)),
    repositorySyntax: [...parsers].map(([plugin, provider]) => ({ provider, ...step(repository.filter(operation => operation.plugin === plugin)) })),
    files: step(files),
    repository: step(repository.filter(({ plugin }) => !parsers.has(plugin))),
    afterFiles: step(afterFiles),
    claims: (plugin: Plugin, path: string) => claims.get(plugin.id)!(path),
  };
}

/** Plugins that parse a language over the whole repository: their repository operations run first, since the files read the structures. */
function repositoryParsers(plugins: readonly Plugin[], languages: LanguageRegistry): Map<Plugin, LanguageProvider> {
  return new Map(plugins.flatMap(plugin => languages.providers.filter(provider => provider.batch && provider.plugin === plugin)
    .map(provider => [plugin, provider] as const)));
}

/** A chosen parser inspects its parsed files. Other inspections use their plugin's claims. */
function claimsOf(plugin: Plugin, languages: LanguageRegistry): (path: string) => boolean {
  return languages.providers.some(provider => provider.plugin === plugin)
    ? path => languages.select(path)?.plugin === plugin : claimMatcher(inspectionClaims(plugin), languages.id);
}

/** The plugins restricted to the given operations, in their order, for the planner to choose from. */
export function candidatesOf(operations: readonly ActiveOperation[]): Plugin[] {
  const byPlugin = new Map<Plugin, Operation[]>();
  for (const { plugin, operation } of operations) byPlugin.set(plugin, [...byPlugin.get(plugin) ?? [], operation]);
  return [...byPlugin].map(([plugin, chosen]) => chosen.length === plugin.operations.length ? plugin : { ...plugin, operations: chosen });
}

/** The external inputs of a phase as the planner reads them, by port name. */
export function phaseInputs({ offers }: Phase, omit?: DataContract): ReadonlyMap<string, string> {
  return new Map(Object.entries(offers).filter(([, contract]) => contract !== omit).map(([port, { id }]) => [port, id]));
}

export type SelectedSource = Readonly<{ file: SourceFile; provider: LanguageProvider | undefined }>;

/** Whether a file is claimed by an inspection that runs on claimed files rather than on every parsed one. */
export function inspectionFileMatcher(languages: LanguageRegistry): (path: string) => boolean {
  const { files, repository } = analysisSteps(languages.plugins, languages, false);
  const claimed = [...files.inspections, ...repository.inspections].filter(({ parsed }) => !parsed);
  return path => claimed.some(({ matches }) => matches(path, false));
}

/** The files of a snapshot with their language providers, and the steps that analyse them. */
export function selectAnalysisSources(snapshot: SourceSnapshot, withCoverage: boolean, languages: LanguageRegistry) {
  const sources: SelectedSource[] = snapshot.files.map(file => ({ file, provider: languages.select(file.path) }));
  const providersByPath = new Map(sources.flatMap(({ file, provider }) => provider ? [[file.path, provider] as const] : []));
  const unavailableFiles = new Set(sources.filter(({ file, provider }) => !provider && languages.skipped(file.path))
    .map(({ file }) => file.path));
  const sourceFiles = sources.flatMap(({ file, provider }) => provider ? [file] : []);
  const steps = analysisSteps(languages.plugins, languages, withCoverage);
  return { languages, sources, sourceFiles, unavailableFiles, providersByPath, steps, plugins: steps.plugins };
}

export type AnalysisSources = ReturnType<typeof selectAnalysisSources>;
