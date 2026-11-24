import { coverage } from '../plugins/coverage/coverage.js';
import { diffCoverage } from '../plugins/coverage/diff-coverage.js';
import { duplication } from '../plugins/duplication/duplication.js';
import { maintainability } from '../plugins/maintainability/maintainability.js';
import { structure } from '../plugins/structure/structure.js';
import { defaultLanguages } from './languages.js';
import { sourceProviders } from './sources.js';
import { securityPlugins } from './security-plugins.js';

export const builtInPlugins = [...defaultLanguages.providers.map(({ plugin }) => plugin), structure, maintainability, duplication, coverage, diffCoverage, ...securityPlugins, ...sourceProviders]
  .map(({ id, version, kinds, claims }) => ({ id, version, kinds, ...(claims ? { claims } : {}) }));
