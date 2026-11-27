// Light highlighting from a language's syntax data: a scanner, not a parser, that colours comments, strings, regular
// expressions, numbers and keywords as the inspection's language declares them. A language that declares no syntax
// comes back as plain text, never in another language's colours.
import type { LanguageSyntax } from '../../json/wire/file-metrics-model.js';
import { element } from './viewer-dom.js';
import { syntaxOf } from './viewer-languages.js';

export type TokenKind = '' | 'c' | 's' | 'n' | 'k';
export type Run = [TokenKind, string];

/** A comment or string form: its start and end markers, the end empty for a comment that runs to the line's end. */
interface Form {
  readonly start: string;
  readonly end: string;
  readonly kind: 'c' | 's';
  readonly multiline: boolean;
  readonly raw: boolean;
}

const form = (kind: Form['kind'], start: string, end: string, multiline = false, raw = false): Form =>
  ({ kind, start, end, multiline, raw });

/** The syntax data in the shape the scanner reads: forms longest marker first, words as sets. */
function grammarOf({ lineComments = [], blockComments = [], strings = [], stringPrefixes = [], keywords, regexAfter }: LanguageSyntax) {
  const forms = [
    ...lineComments.map(start => form('c', start, '', false, true)),
    ...blockComments.map(([start, end]) => form('c', start, end, true, true)),
    ...strings.map(({ quote, multiline, raw }) => form('s', quote, quote, multiline, raw)),
  ];
  return {
    // Longest marker first; the sort is stable, so on equal length a comment, listed first, wins.
    forms: forms.sort((a, b) => b.start.length - a.start.length),
    keywords: new Set(keywords),
    prefixes: new Set(stringPrefixes.map(prefix => prefix.toLowerCase())),
    regexAfter: regexAfter && new Set(regexAfter),
  };
}

type Grammar = ReturnType<typeof grammarOf>;

/** What carries from one line to the next: a form still open, and what a slash means. */
interface ScanState {
  open: Form | undefined;
  regexAllowed: boolean;
}

/** One line being scanned: where the scan stands, by which grammar, and where its runs go. */
interface Cursor {
  readonly line: string;
  readonly grammar: Grammar;
  at: number;
  readonly state: ScanState;
  push(kind: TokenKind, value: string): void;
}

/** Where a form ends from `from` on: the index after its end marker, or the line's end when it stays open. */
function closeAt(line: string, from: number, open: Form): [number, boolean] {
  if (!open.end) return [line.length, true];
  let at = from;
  while (at < line.length && !line.startsWith(open.end, at)) at += !open.raw && line[at] === '\\' ? 2 : 1;
  return at < line.length ? [at + open.end.length, true] : [line.length, false];
}

/** Takes the run up to `stop` as one token. */
function take(cursor: Cursor, kind: TokenKind, stop: number): void {
  cursor.push(kind, cursor.line.slice(cursor.at, stop));
  cursor.at = stop;
}

function close(state: ScanState, closed: Form): void {
  state.open = undefined;
  if (closed.kind === 's') state.regexAllowed = false;
}

/** Inside a form that an earlier line or run left open: up to its end, or the whole line. */
function inside(cursor: Cursor, open: Form): void {
  const [stop, closed] = closeAt(cursor.line, cursor.at, open);
  take(cursor, open.kind, stop);
  if (closed) close(cursor.state, open);
}

/** Opens a form after `prefix` characters: a multi-line one as its start marker, left open; another to its end. */
function begin(cursor: Cursor, opened: Form, prefix: number): void {
  const body = cursor.at + prefix + opened.start.length;
  take(cursor, opened.kind, opened.multiline ? body : closeAt(cursor.line, body, opened)[0]);
  if (opened.multiline) cursor.state.open = opened;
  else close(cursor.state, opened);
}

/**
 * The end of a regular expression literal that starts at `at`, its flags included, honouring escapes and character
 * classes; -1 where the line has no closing slash, so the slash divides after all.
 */
function regexEnd(line: string, at: number): number {
  let end = at + 1;
  let inClass = false;
  while (end < line.length) {
    const current = line[end]!;
    if (current === '\\') {
      end += 2;
      continue;
    }
    if (current === '/' && !inClass) break;
    if (current === '[') inClass = true;
    else if (current === ']') inClass = false;
    end += 1;
  }
  if (end >= line.length) return -1;
  end += 1;
  while (end < line.length && /[a-z]/i.test(line[end]!)) end += 1;
  return end;
}

const char = (cursor: Cursor, offset = 0) => cursor.line[cursor.at + offset];

/** Where a token can start, tried in order; each takes what it recognises and says whether it did. */
const starts: readonly ((cursor: Cursor) => boolean)[] = [
  function marked(cursor) {
    const found = cursor.grammar.forms.find(candidate => cursor.line.startsWith(candidate.start, cursor.at));
    if (!found) return false;
    begin(cursor, found, 0);
    return true;
  },
  function regex(cursor) {
    if (char(cursor) !== '/' || !cursor.grammar.regexAfter || !cursor.state.regexAllowed) return false;
    const end = regexEnd(cursor.line, cursor.at);
    if (end < 0) return false;
    take(cursor, 's', end);
    cursor.state.regexAllowed = false;
    return true;
  },
  function word(cursor) {
    const found = /^[A-Za-z_$][\w$]*/.exec(cursor.line.slice(cursor.at))?.[0];
    if (!found) return false;
    const { grammar } = cursor;
    // A declared string prefix right before a quote belongs to the string.
    const quoted = grammar.prefixes.has(found.toLowerCase())
      && grammar.forms.find(candidate => candidate.kind === 's' && cursor.line.startsWith(candidate.start, cursor.at + found.length));
    if (quoted) {
      begin(cursor, quoted, found.length);
      return true;
    }
    take(cursor, grammar.keywords.has(found) ? 'k' : '', cursor.at + found.length);
    cursor.state.regexAllowed = !!grammar.regexAfter?.has(found);
    return true;
  },
  function number(cursor) {
    const found = /^\.?\d(?:[eEpP][+-]\d|\.\d|\w)*/.exec(cursor.line.slice(cursor.at))?.[0];
    if (!found) return false;
    take(cursor, 'n', cursor.at + found.length);
    cursor.state.regexAllowed = false;
    return true;
  },
  function punctuation(cursor) {
    const found = char(cursor)!;
    take(cursor, '', cursor.at + 1);
    // After a closing bracket a slash divides; after any other punctuation it opens a regular expression.
    if (!/\s/.test(found)) cursor.state.regexAllowed = found !== ')' && found !== ']';
    return true;
  },
];

/** Collects a line's runs, joining plain text into one run between coloured ones. */
function runs() {
  const result: Run[] = [];
  let plain = '';
  return {
    push(kind: TokenKind, value: string): void {
      if (!value) return;
      if (!kind) {
        plain += value;
        return;
      }
      if (plain) result.push(['', plain]);
      plain = '';
      result.push([kind, value]);
    },
    done(): Run[] {
      if (plain) result.push(['', plain]);
      return result;
    },
  };
}

/**
 * Splits lines into coloured runs by a language's syntax data: comments, strings, regular expressions, numbers and
 * keywords. It honours escapes and character classes, and where the data asks for regular expressions it tells one from
 * a division by what comes before the slash. State carries across lines, so a block comment or a multi-line string
 * stays coloured to its end. Without syntax a line comes back as plain text.
 */
export function tokenizer(syntax: LanguageSyntax | undefined): (line: string) => Run[] {
  if (!syntax) return line => [['', line]];
  const grammar = grammarOf(syntax);
  const state: ScanState = { open: undefined, regexAllowed: true };
  return line => {
    const collected = runs();
    const cursor: Cursor = { line, grammar, at: 0, state, push: collected.push };
    while (cursor.at < line.length) {
      if (state.open) inside(cursor, state.open);
      else starts.find(start => start(cursor));
    }
    return collected.done();
  };
}

/** A line's runs as nodes: coloured spans and plain text. */
export function runNodes(lineRuns: readonly Run[]): Node[] {
  return lineRuns.map(([kind, value]) => kind ? element('span', `tok-${kind}`, value) : document.createTextNode(value));
}

/** Highlights a file's lines, or a snippet of them, by the syntax of the file's language. */
export function highlighter(path: string): (line: string) => Node[] {
  const tokenize = tokenizer(syntaxOf(path));
  return line => runNodes(tokenize(line));
}
