import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

const tokens: Grammar['tokens'] = {
  candidates: new Set(['block', 'body', 'attribute']),
  // Preserve block kinds and attribute keys. Abstract labels and other literal values for similar matches.
  kinds: new Map([
    ['numeric_lit', 'number'], ['bool_lit', 'boolean'], ['null_lit', 'null'],
    ['string_lit', 'string'], ['template_literal', 'template-content'], ['heredoc_identifier', 'heredoc-delimiter'],
  ]),
};

export const hcl: Grammar = {
  language: {
    id: 'hcl', label: 'HCL', color: '#844fba', extensions: ['.tf', '.tfvars', '.hcl'],
    measures: ['codeLines', 'commentLines', 'duplication'],
    // Forms stay within the line so comment-like text in a heredoc cannot recolor later code.
    syntax: { lineComments: ['#', '//'], strings: [{ quote: '"' }], keywords: ['true', 'false', 'null'] },
  },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  countDeclarations: root => root.descendantsOfType('block').length,
  columns: 'codepoints',
  name: () => undefined,
  rules: {},
  parens: new Set(), comments: new Set(['comment']), extras: new Set(),
  logicalTypes: new Set(), logicalOperators: new Set(), logicalCognitive: 'parent',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
