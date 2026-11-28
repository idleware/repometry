import type { Operation, Plugin } from '@repometry/core/internal/engine/plugin.js';
import { changesInput } from '@repometry/core/internal/model/changes.js';
import type { GitChanges } from '@repometry/core/internal/model/changes.js';
import { cloneSources } from '@repometry/core/internal/model/clone-source.js';
import { codeStructures } from '@repometry/core/internal/model/code-structure.js';
import { lcovInput } from '@repometry/core/internal/model/coverage-input.js';
import type { CoverageInput } from '@repometry/core/internal/model/coverage-input.js';
import { digest, sourceFiles } from '@repometry/core/internal/model/snapshot.js';
import { exclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import { pluginRegistration } from './registered-plugin.js';

type Matches = (path: string) => boolean;
const fileCollections = new Set([sourceFiles.id, codeStructures.id, cloneSources.id]);

export function pluginScope(plugin: Plugin) {
  const { include, exclude } = pluginRegistration(plugin) ?? {};
  if (include === undefined && exclude === undefined) return undefined;
  return { ...(include === undefined ? {} : { include }), ...(exclude === undefined ? {} : { exclude }) };
}

export function scopedMatcher(plugin: Plugin, defaultMatches: Matches): Matches {
  const scope = pluginScope(plugin);
  if (!scope) return defaultMatches;
  const included = scope.include === undefined ? defaultMatches : exclusionMatcher(scope.include);
  const excluded = exclusionMatcher(scope.exclude ?? []);
  return path => included(path) && !excluded(path);
}

export function scopeOperation(plugin: Plugin, operation: Operation, matches: Matches): Operation {
  const scope = pluginScope(plugin);
  if (!scope || !Object.values(operation.inputs).some(({ id }) => canProject(id))) return operation;
  return {
    ...operation,
    implementation: digest(JSON.stringify([operation.implementation, scope])),
    execute(context) {
      return operation.execute({ ...context, read: (port, contract) => project(context.read(port, contract), contract.id, matches) });
    },
  };
}

function canProject(contract: string): boolean {
  return fileCollections.has(contract) || contract === changesInput.id || contract === lcovInput.id;
}

function project<T>(value: T, contract: string, matches: Matches): T {
  // The operation runner has already validated the input against its contract.
  if (fileCollections.has(contract)) return (value as readonly { path: string }[]).filter(({ path }) => matches(path)) as T;
  if (contract === lcovInput.id) return coverageFiles(value as CoverageInput, matches) as T;
  if (contract === changesInput.id) {
    const changes = value as GitChanges;
    return { files: paths(changes.files, matches), gaps: paths(changes.gaps, matches) } as T;
  }
  return value;
}

function coverageFiles(input: CoverageInput, matches: Matches): CoverageInput {
  return { ...input, sourceLines: paths(input.sourceLines, matches),
    ...(input.codeLines === undefined ? {} : { codeLines: paths(input.codeLines, matches) }),
    ...(input.functionBodies === undefined ? {} : { functionBodies: paths(input.functionBodies, matches) }),
    ...(input.unclassified === undefined ? {} : { unclassified: new Set([...input.unclassified].filter(matches)) }),
    excludes: path => !matches(path) || input.excludes?.(path) === true };
}

function paths<T>(entries: ReadonlyMap<string, T>, matches: Matches): ReadonlyMap<string, T> {
  return new Map([...entries].filter(([path]) => matches(path)));
}
