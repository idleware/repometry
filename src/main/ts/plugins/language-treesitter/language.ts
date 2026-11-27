import type { Node } from 'web-tree-sitter';
import type { ProvidedLanguage } from '../../core/model/language.js';

export interface TokenRules {
  readonly candidates: ReadonlySet<string>;
  readonly kinds: ReadonlyMap<string, string>;
  readonly normalize?: (type: string, text: string, kind: string | undefined) => readonly [string, string | undefined];
}

export interface NodeRule {
  readonly flow?: 'function' | 'class' | 'decorated' | 'if' | 'elif' | 'else' | 'nest' | 'sequence' | 'clause' | 'filter';
  readonly decision?: true | ((node: Node) => number);
  readonly exit?: 'return' | 'label';
  readonly order?: readonly number[];
}

export interface Grammar {
  readonly language: ProvidedLanguage;
  readonly asset: URL;
  readonly decode?: (bytes: Uint8Array) => string;
  readonly prepareSource: (text: string) => string;
  readonly lineBreaks?: RegExp;
  readonly columns: 'bytes' | 'codepoints';
  readonly name: (node: Node) => string | undefined;
  readonly rules: Readonly<Record<string, NodeRule>>;
  readonly parens: ReadonlySet<string>;
  readonly comments: ReadonlySet<string>;
  readonly extras: ReadonlySet<string>;
  readonly logicalTypes: ReadonlySet<string>;
  readonly logicalOperators: ReadonlySet<string>;
  readonly logicalCognitive: 'parent' | 'sequence';
  readonly parameterNames?: string;
  readonly parameterSeparators?: ReadonlySet<string>;
  readonly requireFirst?: string;
  readonly requireNonemptyBlock?: string;
  readonly reportFileRange?: boolean;
  readonly trimObservationComments?: boolean;
  readonly moduleDepthLabel: string;
  readonly tokens: TokenRules;
}

export const measures = ['functions', 'cyclomaticComplexity', 'cognitiveComplexity', 'commentLines', 'codeLines',
  'structuralRules', 'duplication'] as const;
