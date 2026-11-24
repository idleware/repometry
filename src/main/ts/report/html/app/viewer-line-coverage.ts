// A file's line coverage as the source view shows it: each line's state, how often tests ran it, and the words for both.
import type { InspectionDetails } from '../../json/wire/inspection-details-model.js';

/** Line ranges of one file's coverage: 1-based, inclusive and merged. Partial lines ran with some branches missed. */
export type FileLineCoverage = NonNullable<InspectionDetails['lineCoverage']>[string];

export type LineState = 'covered' | 'partial' | 'uncovered';

/** What the source view's lines show: the inspection's findings and complexity, or the tests' coverage. */
export type SourceLayer = 'issues' | 'coverage';

export function isSourceLayer(value: string | null | undefined): value is SourceLayer {
  return value === 'issues' || value === 'coverage';
}

/** Switches a rendered source between its findings and its coverage, without drawing it again. */
export function setSourceLayer(container: HTMLElement, layer: SourceLayer): void {
  const code = container.querySelector<HTMLElement>(':scope > .src');
  if (code) code.dataset.layer = layer;
}

/** Calls back for each line of each range, from line 1 at the earliest. */
function eachLine(ranges: readonly (readonly [number, number, ...number[]])[] | undefined,
  visit: (line: number, range: readonly [number, number, ...number[]]) => void): void {
  for (const range of ranges ?? []) for (let line = Math.max(1, range[0]); line <= range[1]; line++) visit(line, range);
}

/**
 * Each line's coverage, by line number; a line no range names was not measured. Where ranges overlap, the worse
 * state wins: a line a test missed is never shown as covered.
 */
export function lineStates(coverage: FileLineCoverage): Map<number, LineState> {
  const states = new Map<number, LineState>();
  for (const state of ['covered', 'partial', 'uncovered'] as const) eachLine(coverage[state], line => states.set(line, state));
  return states;
}

/** Runs of equal hit counts: first and last line, 1-based and inclusive, and how often tests ran them; 0 is a miss. */
export type HitRun = readonly [first: number, last: number, count: number];

/** How often tests ran each line, where the report carries the counts; an older report has none. */
export function lineHits(coverage: FileLineCoverage): Map<number, number> {
  const hits = new Map<number, number>();
  eachLine(coverage.hits, (line, run) => hits.set(line, run[2]!));
  return hits;
}

// Two figures are enough for a glance; the tooltip has the whole count.
const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 2 });
const fullCount = new Intl.NumberFormat();

/** A count short enough for the gutter: 3×, 980×, 1.2K×, 45K×, 270K×, 3.4M×. */
export function hitLabel(count: number): string {
  return `${count < 1000 ? count : compactCount.format(count)}×`;
}

const lineStateNames: Readonly<Record<LineState, string>> = {
  covered: 'Covered', partial: 'Partly covered: some branches missed', uncovered: 'Not covered',
};

/** What a measured line says to a pointer and a screen reader: its state, and how often it ran where that is known. */
export function lineCoverageText(state: LineState, count?: number): string {
  if (count === undefined || state === 'uncovered') return lineStateNames[state];
  return `${lineStateNames[state]}. Ran ${fullCount.format(count)} ${count === 1 ? 'time' : 'times'}`;
}

/** What the gutter shows on a measured line: its state, the count it writes, and the words for both. */
export interface LineReading {
  readonly state: LineState;
  /** How often the line ran, or how often the functions it starts were called; none where no run is counted. */
  readonly count?: number;
  readonly text: string;
}

function times(count: number): string {
  return `${fullCount.format(count)} ${count === 1 ? 'time' : 'times'}`;
}

/**
 * A declaration line reads as its functions' calls, not as the line's own count: that is how often the module was
 * loaded. Called is covered; never called is red, with no number; where only some of the functions starting on the
 * line ran, it is partial.
 */
export function callReading(calls: readonly number[]): LineReading {
  const total = calls.reduce((sum, count) => sum + count, 0);
  const idle = calls.filter(count => count === 0).length;
  if (total === 0) return { state: 'uncovered', text: calls.length === 1 ? 'Not called' : `Not called: none of the ${calls.length} functions here ran` };
  if (idle === 0) return { state: 'covered', count: total, text: `Called ${times(total)}` };
  return { state: 'partial', count: total, text: `Partly called: ${idle} of the ${calls.length} functions here never ran. Called ${times(total)}` };
}

/** The calls of the functions that start on each line. */
function callsByLine(coverage: FileLineCoverage): Map<number, number[]> {
  const calls = new Map<number, number[]>();
  for (const [line, count] of coverage.functionCalls ?? []) calls.set(line, [...calls.get(line) ?? [], count]);
  return calls;
}

/**
 * What each measured line shows. A line that starts functions shows their calls. Inside a function body a line shows
 * how often it ran. Module-level code runs once per load, so its count says nothing about tests: it keeps its tint and
 * shows no number. A report without function bodies cannot tell the two apart, and every line shows its own count.
 */
export function lineReadings(coverage: FileLineCoverage): Map<number, LineReading> {
  const states = lineStates(coverage);
  const hits = lineHits(coverage);
  const calls = callsByLine(coverage);
  const inBody = new Set<number>();
  eachLine(coverage.functionBodies, line => inBody.add(line));
  const counted = (line: number) => coverage.functionBodies === undefined || inBody.has(line);
  const readings = new Map<number, LineReading>();
  for (const [line, state] of states) {
    const count = counted(line) ? hits.get(line) : undefined;
    readings.set(line, { state, ...(count === undefined ? {} : { count }), text: lineCoverageText(state, count) });
  }
  for (const [line, counts] of calls) readings.set(line, callReading(counts));
  return readings;
}

/** The last line of the gap of codeless, unmeasured lines that starts at `line`. */
function gapEnd(states: ReadonlyMap<number, LineState>, codeless: readonly boolean[], line: number): number {
  let end = line;
  while (end < codeless.length && !states.has(end + 1) && codeless[end]) end += 1;
  return end;
}

/**
 * The tint a gap of blank and comment lines takes so the strip has no breaks: the state of the measured line above it,
 * which the gap closes, or for a gap at the file's start, of the line below. A gap beside a line that was not measured
 * takes its other neighbour, and one with no measured neighbour stays plain.
 */
export function bridgeStates(states: ReadonlyMap<number, LineState>, codeless: readonly boolean[]): Map<number, LineState> {
  const bridged = new Map<number, LineState>();
  let line = 1;
  while (line <= codeless.length) {
    if (states.has(line) || !codeless[line - 1]) {
      line += 1;
      continue;
    }
    const end = gapEnd(states, codeless, line);
    const state = states.get(line - 1) ?? states.get(end + 1);
    if (state) for (let at = line; at <= end; at++) bridged.set(at, state);
    line = end + 1;
  }
  return bridged;
}
