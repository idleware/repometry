// A file's source as numbered lines, lightly highlighted, with the inspection's findings and function complexity laid
// on the lines they describe, or the tests' coverage in the gutter; and the short excerpt a finding shows.
import { element } from './viewer-dom.js';
import { bridgeStates, hitLabel } from './viewer-line-coverage.js';
import type { LineReading, LineState, SourceLayer } from './viewer-line-coverage.js';
import { languageIdOf } from './viewer-languages.js';
import { highlighter, runNodes, tokenizer } from './viewer-tokenizer.js';
import type { Run } from './viewer-tokenizer.js';

export interface SourceFunction {
  readonly line: number;
  readonly complexity: number;
  readonly name: string;
}

export interface SourceNote {
  readonly line: number;
  readonly level: string;
  readonly title: string;
  readonly message: string;
}

export interface SourceOptions {
  readonly path: string;
  readonly functions: readonly SourceFunction[];
  readonly notes: readonly SourceNote[];
  /** What each measured line's gutter shows, where the file has a coverage report. */
  readonly coverage?: ReadonlyMap<number, LineReading> | undefined;
  /** What the lines show first; the view switches it with setSourceLayer. */
  readonly layer?: SourceLayer | undefined;
  /** The line to bring into view and mark, from the URL. */
  readonly line?: number | undefined;
  /** Called when a line number is chosen, so the page can put it in the URL. */
  readonly choose: (line: number) => void;
}

function sourceLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}

/** A function's complexity at its first line, in one of four bands: from 5, 10 and 20 up. */
function complexityBadge(start: SourceFunction): HTMLElement {
  const band = [5, 10, 20].filter(limit => start.complexity >= limit).length;
  const badge = element('span', `src-complexity src-band-${band}`, String(start.complexity));
  badge.title = `Cyclomatic complexity ${start.complexity}`;
  return badge;
}

/**
 * The coverage layer tints each measured line's gutter cell and writes in it how often the line ran, or a function was
 * called; a miss's red says it. Nothing runs on a blank or comment line: where a tool counts one anyway, or it sits
 * inside a run of one state, it keeps the strip's tint and says nothing.
 */
function coverageCell(own: LineReading | undefined, bridged: LineState | undefined): HTMLElement[] {
  const state = own?.state ?? bridged;
  if (!state) return [];
  if (!own) {
    const silent = element('span', `src-cov src-cov-mark-${state}`);
    silent.setAttribute('aria-hidden', 'true');
    return [silent];
  }
  const cell = element('span', `src-cov src-cov-mark-${state}`, own.count === undefined || state === 'uncovered' ? '' : hitLabel(own.count));
  cell.setAttribute('role', 'img');
  cell.setAttribute('aria-label', own.text);
  cell.title = own.text;
  return [cell];
}

function noteBox(note: SourceNote): HTMLElement {
  const box = element('div', `src-note src-note-${note.level}`);
  box.append(element('strong', '', note.title), element('span', '', note.message));
  return box;
}

/** The source as numbered lines; returns a function that brings a line into view and marks it. */
export function renderSource(container: HTMLElement, text: string, options: SourceOptions): (line: number) => void {
  const lines = sourceLines(text);
  // Tokenized up front, in order, since a comment's state carries from line to line.
  const tokenize = tokenizer(languageIdOf(options.path));
  const tokens = lines.map(line => tokenize(line));
  const states = new Map([...options.coverage ?? []].map(([line, reading]) => [line, reading.state]));
  const bridged = bridgeStates(states);
  const starts = new Map(options.functions.map(entry => [entry.line, entry]));
  const notes = new Map<number, SourceNote[]>();
  for (const note of options.notes) notes.set(note.line, [...notes.get(note.line) ?? [], note]);
  const code = element('div', 'src');
  code.dataset.layer = options.layer ?? 'issues';
  code.setAttribute('role', 'region');
  code.setAttribute('aria-label', `Source of ${options.path}`);
  const rows: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();

  function reveal(line: number, scroll = true): void {
    for (const row of code.querySelectorAll('.src-target')) row.classList.remove('src-target');
    const row = rows[line - 1];
    if (!row) return;
    row.classList.add('src-target');
    if (scroll) row.scrollIntoView({ block: 'center' });
  }

  function lineRow(number: number, runs: readonly Run[]): HTMLElement {
    const row = element('div', 'src-line');
    row.id = `L${number}`;
    const mark = element('span', 'src-mark');
    const start = starts.get(number);
    if (start) mark.append(complexityBadge(start));
    mark.append(...coverageCell(options.coverage?.get(number), bridged.get(number)));
    const anchor = element('a', 'src-number', String(number));
    anchor.href = `#L${number}`;
    anchor.addEventListener('click', event => {
      event.preventDefault();
      reveal(number, false);
      options.choose(number);
    });
    const content = element('code', 'src-code');
    content.append(...runNodes(runs));
    if (notes.has(number)) row.classList.add('src-flagged');
    row.append(mark, anchor, content);
    return row;
  }

  for (const [index, runs] of tokens.entries()) {
    const row = lineRow(index + 1, runs);
    rows.push(row);
    fragment.append(row, ...(notes.get(index + 1) ?? []).map(noteBox));
  }
  rows[0]?.classList.add('src-first');
  rows.at(-1)?.classList.add('src-last');
  code.append(fragment);
  container.replaceChildren(code);
  if (options.line) requestAnimationFrame(() => reveal(options.line!));
  return reveal;
}

export interface ExcerptOptions {
  readonly path: string;
  /** The flagged range; the excerpt shows its head with a line of context before it. */
  readonly line: number;
  readonly endLine?: number | undefined;
  /** Where the rest of a long range opens in full. */
  readonly more?: ((line: number) => string) | undefined;
  readonly size?: number;
}

/** The lines an excerpt shows, `from` to `to`, and the last line of the flagged range, which may lie past them. */
export function excerptRange(lineCount: number, options: Pick<ExcerptOptions, 'line' | 'endLine' | 'size'>): { from: number; to: number; end: number } {
  const end = Math.min(lineCount, Math.max(options.line, options.endLine ?? options.line));
  const from = Math.max(1, options.line - 1);
  const to = Math.min(end, from + (options.size ?? 6) - 1, lineCount);
  return { from, to, end };
}

/** The rest of a long range, as a link where the page can open it. */
function moreLines(end: number, to: number, more: ExcerptOptions['more']): HTMLElement {
  const hidden = end - to;
  const rest = element(more ? 'a' : 'span', 'src-more', `⋯ ${hidden} more ${hidden === 1 ? 'line' : 'lines'}, to line ${end}`);
  if (more && rest instanceof HTMLAnchorElement) rest.href = more(to + 1);
  return rest;
}

/**
 * A few lines of source around a finding, bounded so a 160-line function stays a card: one line of context,
 * the head of the flagged range marked, then a link to the rest.
 */
export function renderExcerpt(text: string, options: ExcerptOptions): HTMLElement {
  const lines = sourceLines(text);
  const { from, to, end } = excerptRange(lines.length, options);
  const highlight = highlighter(options.path);
  const box = element('div', 'src src-excerpt');
  // Highlighting runs from the top so a comment or template opened above the excerpt keeps its colour.
  for (const [index, line] of lines.slice(0, to).entries()) {
    const nodes = highlight(line);
    const number = index + 1;
    if (number < from) continue;
    const row = element('div', number >= options.line && number <= end ? 'src-line src-range' : 'src-line');
    const code = element('code', 'src-code');
    code.append(...nodes);
    row.append(element('span', 'src-mark'), element('span', 'src-number', String(number)), code);
    box.append(row);
  }
  if (end > to) box.append(moreLines(end, to, options.more));
  return box;
}

/** The first code on a line, trimmed: a name for an anonymous function that says which one it is. */
export function lineSnippet(text: string, line: number, limit = 60): string | null {
  const found = text.split('\n')[line - 1]?.trim();
  if (!found) return null;
  return found.length > limit ? `${found.slice(0, limit - 1)}…` : found;
}
