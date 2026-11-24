// How a registry metric reads: its values formatted by unit, its changes, its sort order and its colour bands.
import type { Direction, MetricSpec } from './viewer-metric-registry.js';

const integers = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

type Unit = MetricSpec['descriptor']['unit'];

/** Remediation time in hours and minutes: 45 min, 2 h, 3 h 20 min. */
export function duration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${integers.format(rounded)} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${integers.format(hours)} h ${integers.format(rest)} min` : `${integers.format(hours)} h`;
}

const writers: Readonly<Record<Unit, (value: number) => string>> = {
  ratio: value => percent.format(value),
  minutes: duration,
  count: value => integers.format(value),
};

export function format(spec: MetricSpec, value: number | null): string {
  return value === null ? '—' : writers[spec.descriptor.unit](value);
}

/** How large a change is: percentage points for a ratio, time for minutes, a count otherwise. */
const magnitudes: Readonly<Record<Unit, (size: number) => string>> = {
  ratio: size => `${decimal.format(size)} pp`,
  minutes: duration,
  count: size => integers.format(size),
};

/** The signed change between two values: percentage points for a ratio, coloured only where the metric has a better. */
export function difference(spec: MetricSpec, value: number, before: number): { text: string; direction: Direction } {
  const { unit, better } = spec.descriptor;
  const raw = unit === 'ratio' ? (value - before) * 100 : value - before;
  const rounded = unit === 'ratio' ? Math.round(raw * 10) / 10 : Math.round(raw);
  if (rounded === 0) return { text: 'No change', direction: 'same' };
  const improved = (better === 'lower') === (rounded < 0);
  const direction = better === 'none' ? 'neutral' : improved ? 'better' : 'worse';
  return { text: `${rounded > 0 ? '+' : '−'}${magnitudes[unit](Math.abs(rounded))}`, direction };
}

/** The first click on a column sorts worst first. */
export function firstSortAscending(spec: MetricSpec): boolean {
  return spec.descriptor.better === 'higher';
}

/** Missing values sort last in both directions. */
export function compareValues(ascending: boolean): (a: number | null, b: number | null) => number {
  return (a, b) => {
    if (a === null || b === null) return Number(a === null) - Number(b === null);
    return ascending ? a - b : b - a;
  };
}

/** The colour scale: heat where the metric has a better, so the worst is always red; neutral greys where it has none. */
export function bandScale(spec: MetricSpec): 'heat' | 'neutral' {
  return spec.descriptor.better === 'none' ? 'neutral' : 'heat';
}

/** The band of a value against fixed limits; a limit belongs to the better side. */
function fixedStep(limits: readonly number[], value: number, higher: boolean): number {
  const index = limits.findIndex(limit => higher ? value < limit : value <= limit);
  return index < 0 ? limits.length : index;
}

/**
 * One of five bands, 0 best to 4 worst. Fixed by the descriptor's limits where it has them; otherwise relative to the
 * highest value shown. A metric where higher is better turns the scale round. A limit belongs to the better side: at
 * most 5 is the best complexity band, 90% is already the best coverage band.
 */
export function bandOf(spec: MetricSpec, value: number, highest: number): number {
  const limits = spec.descriptor.bands;
  const higher = spec.descriptor.better === 'higher';
  const relative = highest > 0 ? Math.min(4, Math.floor(value / highest * 5)) : 0;
  const step = limits ? fixedStep(limits, value, higher) : relative;
  return higher ? 4 - step : step;
}

const labels: Readonly<Record<Unit, (value: number) => string>> = {
  ratio: value => `${+(value * 100).toFixed(1)}%`,
  minutes: duration,
  count: value => integers.format(value),
};

/** Counts step by whole numbers: ≤5, 6–10 … 51+. */
function countRanges(limits: readonly [number, number, number, number], show: (value: number) => string): string[] {
  return [`≤${show(limits[0])}`, ...limits.slice(1).map((limit, index) => `${show(limits[index]! + 1)}–${show(limit)}`), `${show(limits[3] + 1)}+`];
}

/** Ratios and times run from limit to limit: <5%, 5–15% … 50%+; a ratio's range names its unit once. */
function spanRanges(limits: readonly [number, number, number, number], show: (value: number) => string, unit: Unit): string[] {
  const low = unit === 'ratio' ? (value: number) => show(value).replace(/%$/, '') : show;
  return [`<${show(limits[0])}`, ...limits.slice(1).map((limit, index) => `${low(limits[index]!)}–${show(limit)}`), `${show(limits[3])}+`];
}

/** The legend's words, best band first; null where the bands are relative and the legend reads Lower … Higher. */
export function bandLabels(spec: MetricSpec): string[] | null {
  const limits = spec.descriptor.bands;
  if (!limits) return null;
  const unit = spec.descriptor.unit;
  const ranges = unit === 'count' ? countRanges(limits, labels[unit]) : spanRanges(limits, labels[unit], unit);
  return spec.descriptor.better === 'higher' ? ranges.reverse() : ranges;
}
