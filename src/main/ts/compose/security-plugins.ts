import { jsSecurity } from '../plugins/language-js/js-security.js';
import { actionsSecurity } from '../plugins/security/actions-security.js';
import { dockerfile } from '../plugins/security/dockerfile.js';
import { npmSupplyChain } from '../plugins/security/npm-supply-chain.js';
import { secrets } from '../plugins/security/secrets.js';

export const securityPlugins = [secrets, jsSecurity, actionsSecurity, npmSupplyChain, dockerfile];
