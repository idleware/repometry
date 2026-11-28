import type { LanguageSyntax } from '@repometry/core';

export const javaSyntax: LanguageSyntax = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [{ quote: '"""', multiline: true }, { quote: '"' }, { quote: "'" }],
  // JLS §3.9 reserved keywords, plus the boolean and null literals.
  keywords: [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default',
    'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import',
    'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return',
    'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'void', 'volatile', 'while', '_', 'true', 'false', 'null',
  ],
};
