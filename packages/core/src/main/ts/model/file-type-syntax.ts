import type { LanguageSyntax } from './language.js';

const cFamily: LanguageSyntax = {
  lineComments: ['//'],
  strings: [{ quote: '"' }, { quote: "'" }],
  stringPrefixes: ['L', 'u', 'U', 'u8'],
};

// WG14 N3096 §6.4.1, including the alternative spellings. Line splices can hide block markers.
export const cSyntax: LanguageSyntax = {
  ...cFamily,
  keywords: [
    'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'char', 'const', 'constexpr', 'continue', 'default',
    'do', 'double', 'else', 'enum', 'extern', 'false', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
    'nullptr', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert', 'struct',
    'switch', 'thread_local', 'true', 'typedef', 'typeof', 'typeof_unqual', 'union', 'unsigned', 'void',
    'volatile', 'while', '_Alignas', '_Alignof', '_Atomic', '_BitInt', '_Bool', '_Complex', '_Decimal128',
    '_Decimal32', '_Decimal64', '_Generic', '_Imaginary', '_Noreturn', '_Static_assert', '_Thread_local',
  ],
};

// WG21 N4950 §5.11. Delimited raw strings can contain unbalanced block markers.
export const cppSyntax: LanguageSyntax = {
  ...cFamily,
  keywords: [
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch',
    'char', 'char8_t', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr',
    'constinit', 'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype', 'default', 'delete',
    'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for',
    'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq',
    'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast',
    'requires', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast', 'struct',
    'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union',
    'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
  ],
};

// RFC 8259 §§3 and 7.
export const jsonSyntax: LanguageSyntax = {
  strings: [{ quote: '"' }],
  keywords: ['false', 'null', 'true'],
};

// CSS Syntax Level 3 §4.3.5. Unquoted URL tokens can contain block markers.
export const cssSyntax: LanguageSyntax = {
  strings: [{ quote: '"' }, { quote: "'" }],
};

// Dockerfile reference: conventional uppercase instructions and the FROM stage marker.
export const dockerfileSyntax: LanguageSyntax = {
  strings: [{ quote: '"' }, { quote: "'" }],
  keywords: [
    'ADD', 'ARG', 'CMD', 'COPY', 'ENTRYPOINT', 'ENV', 'EXPOSE', 'FROM', 'HEALTHCHECK', 'LABEL', 'MAINTAINER',
    'ONBUILD', 'RUN', 'SHELL', 'STOPSIGNAL', 'USER', 'VOLUME', 'WORKDIR', 'AS',
  ],
};
