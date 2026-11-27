import type { Plugin } from '../core/engine/plugin.js';
import type { HostLanguageDescriptor } from '../core/ports/tool-runner.js';
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

/** The built-in plugins in run order. The first language plugin is the default provider. */
export const builtInPlugins: readonly Plugin[] = [babelProvider, structure, maintainability, duplication, coverage, diffCoverage,
  secrets, jsSecurity, actionsSecurity, npmSupplyChain, dockerfile, githubSource, gitlabSource, localSource];

const measures = ['functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'commentLines', 'codeLines',
  'structuralRules', 'duplication'] as const;

/** Languages parsed by a host tool when it is installed. */
export const hostLanguages: readonly HostLanguageDescriptor[] = [
  { id: 'go-ast', language: 'go', binary: 'go', args: ['run'], versionArgs: ['version'], script: 'go/parser.go', measures,
    syntax: { lineComments: ['//'], blockComments: [['/*', '*/']],
      strings: [{ quote: '"' }, { quote: "'" }, { quote: '`', multiline: true, raw: true }],
      keywords: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go',
        'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
        'true', 'false', 'nil', 'iota'],
    },
  },
  { id: 'python-ast', language: 'python', binary: 'python3', args: ['-I', '-S'], versionArgs: ['--version'],
    script: 'python/parser.py', measures: [...measures, 'classes'],
    syntax: { lineComments: ['#'],
      strings: [{ quote: '"""', multiline: true }, { quote: "'''", multiline: true }, { quote: '"' }, { quote: "'" }],
      stringPrefixes: ['r', 'u', 'b', 'f', 't', 'br', 'rb', 'fr', 'rf', 'tr', 'rt'],
      keywords: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
        'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
        'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
    },
  },
];
