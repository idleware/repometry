import { builtInGrammarTools, builtInPlugins } from '../plugins/built-in.js';

// The one edge from compose to plugins: everything else in compose reads the built-ins from here.
export { builtInGrammarTools, builtInPlugins };

export const builtInPluginIds: ReadonlySet<string> = new Set(builtInPlugins.map(({ id }) => id));
