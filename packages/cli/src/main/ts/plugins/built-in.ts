import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { bundledPlugin } from '@repometry/core/internal/engine/plugin-manifest.js';
import { coverage } from './coverage/coverage.js';
import { diffCoverage } from './coverage/diff-coverage.js';
import { duplication } from './duplication/duplication.js';
import { babelProvider } from './language-js/babel-provider.js';
import { jsSecurity } from './language-js/js-security.js';
import { maintainability } from './maintainability/maintainability.js';
import { actionsSecurity } from './security/actions-security.js';
import { dockerfile } from './security/dockerfile.js';
import { npmSupplyChain } from './security/npm-supply-chain.js';
import { secrets } from './security/secrets.js';
import { githubSource, gitlabSource, localSource } from './source/forges.js';
import { structure } from './structure/structure.js';

// The review path uses the importer kind, which is also part of existing inspection profiles.
const lcov: Plugin = { ...bundledPlugin(coverage), kinds: ['coverage', 'import'] };

/** The built-in plugins in run order. The first language plugin is the default provider. */
export const builtInPlugins: readonly Plugin[] = [babelProvider, bundledPlugin(structure), maintainability, duplication, lcov, bundledPlugin(diffCoverage),
  secrets, jsSecurity, actionsSecurity, npmSupplyChain, dockerfile, githubSource, gitlabSource, localSource];
