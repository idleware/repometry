import { realpath } from 'node:fs/promises';
import { gitRoot } from './api/git/git.js';
import { inspect as inspectRun } from './compose/inspect.js';
import type { InspectRequest as Inspection } from './compose/inspect.js';
import { measureDiffCoverage as measure } from './compose/diff-coverage.js';
import type { DiffCoverageRequest as Diff } from './compose/diff-coverage.js';
import { review as reviewRun } from './compose/review.js';
import type { ReviewRequest as Review } from './compose/review.js';
import { distributionParsers, slimDistribution } from './compose/distribution.js';
import type { Distribution } from './compose/distribution.js';
import { loadPlugins } from './compose/load-plugins.js';
import type { PluginInput } from './compose/load-plugins.js';

type PluginInputs = { readonly plugins?: readonly PluginInput[] };
export type InspectRequest = Omit<Inspection, 'plugins' | 'operationCache'> & PluginInputs;
export type DiffCoverageRequest = Omit<Diff, 'plugins'> & PluginInputs;
export type ReviewRequest = Omit<Review, 'plugins'> & PluginInputs;

export function createRepometry(distribution: Distribution = slimDistribution) {
  return {
    async inspect({ plugins, ...request }: InspectRequest) {
      const loaded = await pluginInputs(plugins, request.directory, 'workingTree' in request.source, distribution);
      return inspectRun({ ...request, plugins: loaded, parsers: distributionParsers(distribution, request.parsers) });
    },
    async measureDiffCoverage({ plugins, ...request }: DiffCoverageRequest) {
      const loaded = await pluginInputs(plugins, request.directory, false, distribution);
      return measure({ ...request, plugins: loaded, parsers: distributionParsers(distribution, request.parsers) });
    },
    async review({ plugins, ...request }: ReviewRequest) {
      const loaded = await pluginInputs(plugins, request.directory, false, distribution);
      return reviewRun({ ...request, plugins: loaded, parsers: distributionParsers(distribution, request.parsers) });
    },
  };
}

async function pluginInputs(plugins: readonly PluginInput[] | undefined, directory: string, workingTree: boolean,
  distribution: Distribution) {
  if (!plugins?.length) return loadPlugins([], directory, undefined, false, distribution);
  const root = await realpath(workingTree ? directory : await gitRoot(directory));
  return loadPlugins(plugins, root, undefined, false, distribution);
}
