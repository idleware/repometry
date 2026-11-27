import type { LanguageSyntax } from '@repometry/core';

export const goSyntax: LanguageSyntax = { lineComments: ['//'], blockComments: [['/*', '*/']],
  strings: [{ quote: '"' }, { quote: "'" }, { quote: '`', multiline: true, raw: true }],
  keywords: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go',
    'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
    'true', 'false', 'nil', 'iota'],
};
