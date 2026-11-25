import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { parse } from '@babel/parser';
import type { ParserOptions } from '@babel/parser';
import { pluginApi } from '../../core/engine/plugin.js';
import type { Plugin } from '../../core/engine/plugin.js';
import { javascriptType, typescriptType } from '../../core/model/file-types.js';
import { codeStructure } from '../../core/model/code-structure.js';
import type { CodeStructure } from '../../core/model/code-structure.js';
import { physicalLines, sourceFile, utf8 } from '../../core/model/snapshot.js';
import { cloneCandidates } from './clone-candidates.js';
import { classifyLines } from './code-lines.js';
import { functionFacts } from './function-facts.js';
import { qualifiedNames } from './qualified-names.js';
import { structuralObservations } from './structural-observations.js';
import { jsTsExtensions } from './extensions.js';

const require = createRequire(import.meta.url);
export const parserDefaults = { sourceType: 'unambiguous', errorRecovery: false, attachComment: false } as const;

export const babelTypes = { '@babel/types': require('@babel/types/package.json').version as string };

export const babelProvider: Plugin = {
  id: 'babel-syntax',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['language'],
  claims: { extensions: jsTsExtensions, languages: ['javascript', 'typescript'] },
  providesLanguages: [javascriptType, typescriptType],
  settings: parserDefaults,
  produces: [{ contract: codeStructure.id, persistence: 'transient' }],
  tools: { '@babel/parser': require('@babel/parser/package.json').version as string, ...babelTypes },
  operations: [{
    id: 'parse',
    role: 'provider',
    inputs: { source: sourceFile },
    output: codeStructure,
    execute(inputs): CodeStructure {
      const file = inputs.read('source', sourceFile);
      const source = utf8(file.bytes);
      const ext = extname(file.path);
      const plugins: NonNullable<ParserOptions['plugins']> = [];
      if ((typescriptType.extensions as readonly string[]).includes(ext)) {
        plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(file.path), disallowAmbiguousJSXLike: ext === '.mts' || ext === '.cts' }]);
      }
      if (ext === '.jsx' || ext === '.tsx') plugins.push('jsx');
      const sourceType = ext === '.mjs' || ext === '.mts' ? 'module'
        : ext === '.cjs' || ext === '.cts' ? 'commonjs' : parserDefaults.sourceType;
      const ast = parse(source, { ...parserDefaults, sourceType, plugins });
      const lines = physicalLines(source);
      const { code, comments } = classifyLines(source, ast, lines);
      const names = qualifiedNames(ast);
      return { path: file.path, lines, commentLines: comments, ...functionFacts(ast, names),
        ...structuralObservations(ast, names), clones: cloneCandidates(file.path, ast, code) };
    },
  }],
};
