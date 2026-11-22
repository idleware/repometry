import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { parse } from '@babel/parser';
import type { ParserOptions } from '@babel/parser';
import { pluginApi } from '../../core/engine/plugin.js';
import type { Plugin } from '../../core/engine/plugin.js';
import { codeStructure } from '../../core/model/code-structure.js';
import type { CodeStructure } from '../../core/model/code-structure.js';
import { physicalLines, sourceExtensions, sourceFile, utf8 } from '../../core/model/snapshot.js';
import { cloneCandidates } from './clone-candidates.js';
import { classifyLines } from './code-lines.js';
import { functionFacts } from './function-facts.js';
import { structuralObservations } from './structural-observations.js';

const require = createRequire(import.meta.url);
export const parserDefaults = { sourceType: 'unambiguous', errorRecovery: false, attachComment: false } as const;

export const babelTypes = { '@babel/types': require('@babel/types/package.json').version as string };

export const babelProvider: Plugin = {
  id: 'babel-syntax',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['language'],
  claims: { extensions: sourceExtensions, languages: ['javascript', 'typescript'] },
  produces: [{ contract: codeStructure.id, persistence: 'transient' }],
  tools: { '@babel/parser': require('@babel/parser/package.json').version as string },
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
      if (['.ts', '.mts', '.cts', '.tsx'].includes(ext)) {
        plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(file.path), disallowAmbiguousJSXLike: ext === '.mts' || ext === '.cts' }]);
      }
      if (ext === '.jsx' || ext === '.tsx') plugins.push('jsx');
      const sourceType = ext === '.mjs' || ext === '.mts' ? 'module'
        : ext === '.cjs' || ext === '.cts' ? 'commonjs' : parserDefaults.sourceType;
      const ast = parse(source, { ...parserDefaults, sourceType, plugins });
      const lines = physicalLines(source);
      const { code, comments } = classifyLines(source, ast, lines);
      return { path: file.path, lines, commentLines: comments, ...functionFacts(ast),
        ...structuralObservations(ast), clones: cloneCandidates(file.path, ast, code) };
    },
  }],
};
