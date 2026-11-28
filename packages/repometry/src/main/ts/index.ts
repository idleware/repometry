import { realpath } from 'node:fs/promises';
import { gitRoot } from './api/git/git.js';
import { inspect as inspectRun } from './compose/inspect.js';
import type { InspectRequest as Inspection } from './compose/inspect.js';
import { measureDiffCoverage as measure } from './compose/diff-coverage.js';
import type { DiffCoverageRequest as Diff } from './compose/diff-coverage.js';
import { review as reviewRun } from './compose/review.js';
import type { ReviewRequest as Review } from './compose/review.js';
import { loadPlugins } from './compose/load-plugins.js';
import type { PluginInput } from './compose/load-plugins.js';

type PluginInputs = { readonly plugins?: readonly PluginInput[] };
export type InspectRequest = Omit<Inspection, 'plugins' | 'operationCache'> & PluginInputs;
export type DiffCoverageRequest = Omit<Diff, 'plugins'> & PluginInputs;
export type ReviewRequest = Omit<Review, 'plugins'> & PluginInputs;

export async function inspect({ plugins, ...request }: InspectRequest) {
  return inspectRun({ ...request, plugins: await pluginInputs(plugins, request.directory, 'workingTree' in request.source) });
}

export async function measureDiffCoverage({ plugins, ...request }: DiffCoverageRequest) {
  return measure({ ...request, plugins: await pluginInputs(plugins, request.directory, false) });
}

export async function review({ plugins, ...request }: ReviewRequest) {
  return reviewRun({ ...request, plugins: await pluginInputs(plugins, request.directory, false) });
}

async function pluginInputs(plugins: readonly PluginInput[] | undefined, directory: string, workingTree: boolean) {
  if (!plugins?.length) return [];
  const root = await realpath(workingTree ? directory : await gitRoot(directory));
  return loadPlugins(plugins, root, undefined);
}

export { reviewExitCode } from './compose/review.js';
export type { DiffCoveragePorts, DiffCoverageSource } from '@repometry/core/internal/usecases/diff-coverage.js';
export type { ReviewOptions } from '@repometry/core/internal/usecases/review.js';
export type { FindingInput } from './api/import/finding-import.js';
export type { FindingIgnoreRule as IgnoreEntry } from '@repometry/core/internal/model/ignore-rule.js';
