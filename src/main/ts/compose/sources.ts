import { plan } from '../core/engine/plan.js';
import type { SourceContext, SourcePlugin } from '../core/ports/source-provider.js';
import { builtInPlugins } from './built-ins.js';

export function resolveSourceLocator(option: string | undefined, context: Omit<SourceContext, 'option'>,
  providers = builtInPlugins.filter((plugin): plugin is SourcePlugin => plugin.kinds.includes('source'))) {
  plan({ plugins: providers, select: [], inputs: new Map() });
  if (option === 'none') return undefined;
  if (option && option !== 'auto') return namedSourceLocator(option, context, providers);
  // A provider that locates sources without CI variables or remotes is the fallback, tried last.
  const fallback = providers.find(provider => provider.locate({ env: {}, remotes: [] }) !== undefined);
  for (const candidate of [{ env: context.env, remotes: [] }, { env: {}, remotes: context.remotes }]) {
    for (const provider of providers) {
      const locator = provider === fallback ? undefined : provider.locate(candidate);
      if (locator) return locator;
    }
  }
  return fallback?.locate(context);
}

function namedSourceLocator(option: string, context: Omit<SourceContext, 'option'>, providers: readonly SourcePlugin[]) {
  const colon = option.indexOf(':');
  const id = colon < 0 ? option : option.slice(0, colon);
  const spec = colon < 0 ? undefined : option.slice(colon + 1);
  const provider = providers.find(item => item.id === id);
  if (!provider) throw new Error(`Unknown source provider: ${id}. Choose ${providers.map(item => item.id).join(', ')}.`);
  const locator = provider.locate({ ...context, option: spec });
  if (!locator) throw new Error(`Cannot locate sources for ${id}. Name the repository as ${id}:OWNER/REPO.`);
  return locator;
}
