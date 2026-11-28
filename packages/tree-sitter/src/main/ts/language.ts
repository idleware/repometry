import type { Node } from 'web-tree-sitter';
import type { ProvidedLanguage } from '@repometry/core/internal/model/language.js';

// The published web-tree-sitter 0.27.2 declarations reference browser globals from their optional Emscripten and WASM
// APIs. The engine calls Parser.init without an options object and loads grammars from bytes. Declared here, in a module,
// so the shim ships with the declarations of every package that uses these types.
declare global {
  interface EmscriptenModule {
    locateFile?: (filename: string, directory: string) => string;
  }

  namespace WebAssembly {
    interface Module {}
  }
}

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
  /** Body members when the grammar does not expose a single body field. */
  readonly body?: (node: Node) => readonly Node[];
  /** Keep a signature without a body outside measured functions. */
  readonly requiresBody?: boolean;
  /** Lexical parameter count when the grammar does not expose a list of formal parameters. */
  readonly parameters?: (node: Node) => number | undefined;
  /** Alternate branch when the grammar does not expose an alternative field. */
  readonly alternative?: (node: Node) => Node | null;
  /** Whether an alternative wrapper contributes its flat cognitive point. */
  readonly elseCognitive?: (node: Node) => boolean;
  /** A wrapper is transparent when its sole named child is a chained conditional. */
  readonly chainedAlternative?: true;
}

export interface Grammar {
  readonly language: ProvidedLanguage;
  /** The grammar package the WASM file was built from, recorded in the plugin's tools. */
  readonly tool: { readonly package: string; readonly version: string };
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
  /** A parameters field with one of these node types is a single parameter. */
  readonly singleParameterTypes?: ReadonlySet<string>;
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
