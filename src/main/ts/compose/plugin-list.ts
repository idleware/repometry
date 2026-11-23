import { coverage } from '../plugins/coverage/coverage.js';
import { diffCoverage } from '../plugins/coverage/diff-coverage.js';
import { duplication } from '../plugins/duplication/duplication.js';
import { babelProvider } from '../plugins/language-js/babel-provider.js';
import { maintainability } from '../plugins/maintainability/maintainability.js';
import { structure } from '../plugins/structure/structure.js';
import { sourceProviders } from './sources.js';
import { securityPlugins } from './security-plugins.js';

export const builtInPlugins = [babelProvider, structure, maintainability, duplication, coverage, diffCoverage, ...securityPlugins, ...sourceProviders]
  .map(({ id, version, kinds, claims }) => ({ id, version, kinds, ...(claims ? { claims } : {}) }));
