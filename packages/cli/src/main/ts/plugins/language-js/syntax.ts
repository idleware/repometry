import type { LanguageSyntax } from '@repometry/core/internal/model/language.js';

export const jsSyntax: LanguageSyntax = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [{ quote: "'" }, { quote: '"' }, { quote: '`', multiline: true }],
  keywords: ('abstract as async await break case catch class const continue debugger declare default delete do else enum '
    + 'export extends false finally for from function get if implements import in instanceof interface let new null of '
    + 'package private protected public readonly return satisfies set static super switch this throw true try type typeof '
    + 'undefined var void while with yield').split(' '),
  regexAfter: 'return typeof instanceof in of new delete void throw case do else yield await'.split(' '),
};
