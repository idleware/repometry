import type { StructureMeasure } from './code-structure.js';
import { isJsonValue, isRecord } from './plugin-data.js';

export interface LanguageDisplay {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
}

export interface LanguageLookup {
  readonly catalog: readonly LanguageDisplay[];
  id(path: string): string;
  syntax?(id: string): LanguageSyntax | undefined;
}

/**
 * How the viewer colours a language's source: data for a scanner, not a grammar. Every field is optional; a language
 * with no syntax shows as plain text.
 */
export interface LanguageSyntax {
  /** Markers that start a comment running to the end of the line, such as `//` or `#`. */
  readonly lineComments?: readonly string[];
  /** Start and end markers of comments that may span lines, such as slash-star and star-slash. They do not nest. */
  readonly blockComments?: readonly (readonly [start: string, end: string])[];
  /**
   * String forms. A string ends at the same quote that opened it. A backslash escapes the next character unless the form
   * is raw. A form that is not multi-line ends at the end of the line.
   */
  readonly strings?: readonly { readonly quote: string; readonly multiline?: boolean; readonly raw?: boolean }[];
  /** Letters that may stand right before a quote and belong to the string, compared without case: `r`, `b`, `f`, `rb`. */
  readonly stringPrefixes?: readonly string[];
  /** Words coloured as keywords, literals such as `true` and `nil` among them. Compared with case. */
  readonly keywords?: readonly string[];
  /** Words after which a slash opens a regular-expression literal, as in JavaScript. Without this field a slash is plain. */
  readonly regexAfter?: readonly string[];
}

export interface ProvidedLanguage extends LanguageDisplay {
  readonly extensions?: readonly string[];
  readonly globs?: readonly string[];
  readonly measures?: readonly StructureMeasure[];
  readonly syntax?: LanguageSyntax;
}

export function isLanguageDisplay(value: unknown): value is LanguageDisplay {
  return isRecord(value) && typeof value.id === 'string' && /^[a-z][a-z0-9-]*$/.test(value.id)
    && typeof value.label === 'string' && value.label.trim().length > 0
    && (value.color === undefined || typeof value.color === 'string' && /^#[a-f\d]{6}$/i.test(value.color));
}

const syntaxChecks: Record<keyof LanguageSyntax, (value: unknown) => boolean> = {
  lineComments: value => entries(value, marker),
  blockComments: value => entries(value, pair => Array.isArray(pair) && pair.length === 2 && marker(pair[0]) && marker(pair[1])),
  strings: value => entries(value, stringForm),
  stringPrefixes: value => entries(value, word),
  keywords: value => entries(value, word, 512),
  regexAfter: value => entries(value, word),
};

export function isLanguageSyntax(value: unknown): value is LanguageSyntax {
  return isRecord(value) && isJsonValue(value)
    && Object.entries(value).every(([key, item]) =>
      Object.hasOwn(syntaxChecks, key) && syntaxChecks[key as keyof LanguageSyntax](item));
}

function entries(value: unknown, valid: (item: unknown) => boolean, maximum = Infinity): boolean {
  return Array.isArray(value) && value.length <= maximum && Array.from(value).every(valid);
}

function marker(value: unknown): boolean {
  return typeof value === 'string' && /^\S{1,8}$/u.test(value);
}

function word(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value);
}

function stringForm(value: unknown): boolean {
  return isRecord(value) && marker(value.quote) && Object.entries(value).every(([key, item]) =>
    key === 'quote' || ((key === 'multiline' || key === 'raw') && typeof item === 'boolean'));
}
