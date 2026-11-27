import { builtInPlugins, hostLanguages } from '../plugins/built-in.js';

// The one edge from compose to plugins: everything else in compose reads the built-ins from here.
export { builtInPlugins, hostLanguages };

export const builtInPluginIds: ReadonlySet<string> = new Set([...builtInPlugins, ...hostLanguages].map(({ id }) => id));
