import type { LanguageSyntax } from '../../../core/model/language.js';

export const pythonSyntax: LanguageSyntax = { lineComments: ['#'],
  strings: [{ quote: '"""', multiline: true }, { quote: "'''", multiline: true }, { quote: '"' }, { quote: "'" }],
  stringPrefixes: ['r', 'u', 'b', 'f', 't', 'br', 'rb', 'fr', 'rf', 'tr', 'rt'],
  keywords: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
    'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
};
