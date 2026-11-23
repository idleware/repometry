// The metric registry, built from the descriptors the report carries: how the viewer names, reads, formats, compares,
// sorts and colours a metric it has no code for. The Repometry metrics the viewer draws by hand keep those surfaces;
// every other metric, Repometry's newer ones included, is drawn from its descriptor alone.
import type { MetricDescriptor, MetricValues } from '../../json/wire/summary-model.js';

export type { MetricDescriptor, MetricValues } from '../../json/wire/summary-model.js';
export type Direction = 'better' | 'worse' | 'same' | 'neutral';

export interface MetricSpec {
  readonly descriptor: MetricDescriptor;
  /** The word the query field takes and the Trends view id: `todo-count`. */
  readonly key: string;
  readonly plugin: string;
  readonly label: string;
  /** The column header. */
  readonly short: string;
  readonly group: string;
  /** A Metrics column shown before the reader picks columns. */
  readonly column: boolean;
  /** Offered in the Hotspots metric menu. */
  readonly hotspot: boolean;
  /** Has one value per commit, so a trend chart. */
  readonly trend: boolean;
  /** A count another metric's ratio is made of, as covered branches are of branch coverage. */
  readonly ratioPart: boolean;
}

/** A row that may carry values: a commit, a file or a folder. */
export interface Valued {
  readonly values?: MetricValues | undefined;
  readonly analysed?: boolean | undefined;
}

/** Repometry's metrics keep short query words; every other key comes from the descriptor's id. */
const builtinKeys: Readonly<Record<string, string>> = {
  'repometry.cyclomatic-babel/v1': 'complexity',
  'repometry.cognitive-babel/v1': 'cognitive',
  'repometry.code-lines-babel/v1': 'lines',
  'repometry.functions/v1': 'functions',
  'repometry.lcov-line-coverage/v1': 'coverage',
  'repometry.duplicated-lines-babel/v1': 'duplication',
  'repometry.git-change-frequency/v1': 'changes',
  'repometry.lcov-branch-coverage/v1': 'branch-coverage',
  'repometry.lcov-covered-branches/v1': 'covered-branches',
  'repometry.lcov-coverable-branches/v1': 'coverable-branches',
  'repometry.lcov-function-coverage/v1': 'function-coverage',
  'repometry.lcov-covered-functions/v1': 'covered-functions',
  'repometry.lcov-coverable-functions/v1': 'coverable-functions',
};
/** The Repometry metrics the viewer draws from typed fields, with their own labels, columns and charts. */
const handDrawn: ReadonlySet<string> = new Set([
  'repometry.physical-lines/v1', 'repometry.functions/v1', 'repometry.cyclomatic-babel/v1', 'repometry.cognitive-babel/v1',
  'repometry.classes-babel/v1', 'repometry.code-lines-babel/v1', 'repometry.comment-lines-babel/v1',
  'repometry.duplicated-lines-babel/v1', 'repometry.lcov-line-coverage/v1', 'repometry.lcov-covered-lines/v1',
  'repometry.lcov-coverable-lines/v1', 'repometry.git-change-frequency/v1',
]);
/** Words that already mean something: query keys, Trends views and the series the viewer draws by hand. */
const reserved = new Set(['lang', 'language', 'component', 'path', 'in', 'has', 'analysed', 'ignored', 'lockfile', 'lockfiles', 'remediation', 'missedlines', 'churn',
  'debt', 'debt-changes', 'diff-coverage', 'effort', 'smells', 'files', 'classes', 'comments', 'code-lines', 'security',
  'coverable-lines', 'covered-lines', 'uncovered-lines', 'security-high', 'security-medium', 'security-low',
  ...Object.values(builtinKeys)]);
/** Curated groups first, in this order; groups named by plugins follow in catalog order. */
export const curatedGroups = ['Maintainability', 'Coverage', 'Security', 'Size'] as const;

/** The metrics the viewer draws from their typed fields; a Repometry metric it has no code for goes by its descriptor. */
export function isBuiltin(descriptor: MetricDescriptor): boolean {
  return handDrawn.has(descriptor.id);
}

function parts(id: string): { plugin: string; name: string } {
  const bare = id.replace(/\/v\d+$/, '');
  const dot = bare.indexOf('.');
  return dot < 0 ? { plugin: bare, name: bare } : { plugin: bare.slice(0, dot), name: bare.slice(dot + 1) };
}

/** One spec per descriptor, in catalog order; descriptors listed twice by id count once. */
export function metricSpecs(catalog: readonly MetricDescriptor[]): MetricSpec[] {
  const unique = [...new Map(catalog.map(descriptor => [descriptor.id, descriptor])).values()];
  // Two versions of one metric share a key: a commit measures one of them. Two plugins naming the same metric do not.
  const owners = new Map<string, Set<string>>();
  for (const { id } of unique) {
    const { plugin, name } = parts(id);
    owners.set(name, (owners.get(name) ?? new Set()).add(plugin));
  }
  // The counts a ratio is made of (covered and measured branches) read through the ratio: no chart, column or rank of their own.
  const ratioParts = new Set(unique.flatMap(({ ratio }) => ratio ? [ratio.of, ratio.over] : []));
  return unique.map(descriptor => {
    const { plugin, name } = parts(descriptor.id);
    const builtin = builtinKeys[descriptor.id];
    const key = builtin ?? (owners.get(name)!.size > 1 || reserved.has(name.toLowerCase()) ? `${plugin}.${name}` : name);
    const rolls = descriptor.aggregate !== 'none' || descriptor.ratio !== undefined;
    const ranked = descriptor.scope === 'file' && descriptor.better !== 'none' && !ratioParts.has(descriptor.id);
    return {
      descriptor, key, plugin,
      label: descriptor.label,
      short: descriptor.short ?? descriptor.label,
      group: descriptor.group ?? plugin,
      // Repometry's own columns are curated; its metrics without a hand-made column are there to pick, not shown first.
      column: ranked && plugin !== 'repometry',
      hotspot: ranked && rolls,
      trend: !ratioParts.has(descriptor.id) && (descriptor.scope === 'repository' || rolls),
      ratioPart: ratioParts.has(descriptor.id),
    };
  });
}

/** Positions of a catalog's metrics by id: summary indexes for commits, the detail's own indexes for files. */
export function catalogIndex(catalog: readonly MetricDescriptor[] | undefined): Map<string, number> {
  return new Map((catalog ?? []).map((descriptor, index) => [descriptor.id, index]));
}

/** Specs by key, for the query field and the Trends views. Where versions share a key, the one the index holds wins. */
export function byKey(specs: readonly MetricSpec[], index?: ReadonlyMap<string, number>): Map<string, MetricSpec> {
  const keys = new Map<string, MetricSpec>();
  for (const spec of specs) {
    if (!keys.has(spec.key) || index?.has(spec.descriptor.id)) keys.set(spec.key, spec);
  }
  return keys;
}

/** The Trends groups: the curated ones in their order, then each plugin's, with the specs that have a trend. */
export function trendGroups(specs: readonly MetricSpec[]): [string, MetricSpec[]][] {
  const groups = new Map<string, MetricSpec[]>(curatedGroups.map(group => [group, []]));
  for (const spec of specs) if (spec.trend) groups.set(spec.group, [...groups.get(spec.group) ?? [], spec]);
  return [...groups].filter(([, members]) => members.length > 0);
}

/** The id whose presence says a metric was measured: a ratio is measured where its denominator is. */
function measuredId(spec: MetricSpec): string {
  return spec.descriptor.ratio?.over ?? spec.descriptor.id;
}

/**
 * The repository's value at a commit. A commit lists every metric it measured, null where nothing rolls up; a metric
 * it does not list did not run, and has no value, so a chart breaks its line instead of dropping to zero.
 */
export function commitValue(index: ReadonlyMap<string, number>, commit: Valued, spec: MetricSpec): number | null {
  const values = commit.values;
  const at = index.get(measuredId(spec));
  if (!values || at === undefined || !(at in values)) return null;
  const ratio = spec.descriptor.ratio;
  if (!ratio) return values[at] ?? null;
  const of = index.get(ratio.of);
  const total = values[at] ?? 0;
  return total > 0 && of !== undefined ? (values[of] ?? 0) / total : null;
}

/**
 * A file's or folder's value against the detail's own catalog. None for a file no plugin analysed, nor for a metric
 * this inspection did not run. Within a measured metric a missing value is zero: zeros are left out of the data.
 */
export function entryValue(index: ReadonlyMap<string, number>, entry: Valued, spec: MetricSpec): number | null {
  if (entry.analysed === false) return null;
  const at = index.get(measuredId(spec));
  if (at === undefined) return null;
  const ratio = spec.descriptor.ratio;
  if (!ratio) return entry.values?.[at] ?? 0;
  const of = index.get(ratio.of);
  const total = entry.values?.[at] ?? 0;
  return total > 0 && of !== undefined ? (entry.values?.[of] ?? 0) / total : null;
}

/** The values of a group of files the viewer gathers itself (a filtered folder, a component), by each metric's roll-up. */
export function rollUp(catalog: readonly MetricDescriptor[] | undefined, entries: readonly Valued[]): MetricValues | undefined {
  if (!catalog?.length) return undefined;
  const values: Record<number, number> = {};
  catalog.forEach((descriptor, index) => {
    if (descriptor.aggregate === 'none') return;
    let total = 0;
    for (const entry of entries) {
      if (entry.analysed === false) continue;
      const value = entry.values?.[index] ?? 0;
      total = descriptor.aggregate === 'max' ? Math.max(total, value) : total + value;
    }
    if (total !== 0) values[index] = total;
  });
  return values;
}

const integers = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function duration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${integers.format(rounded)} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${integers.format(hours)} h ${integers.format(rest)} min` : `${integers.format(hours)} h`;
}

export function format(spec: MetricSpec, value: number | null): string {
  if (value === null) return '—';
  switch (spec.descriptor.unit) {
    case 'ratio': return percent.format(value);
    case 'minutes': return duration(value);
    case 'count': return integers.format(value);
  }
}

/** The signed change between two values: percentage points for a ratio, coloured only where the metric has a better. */
export function difference(spec: MetricSpec, value: number, before: number): { text: string; direction: Direction } {
  const { unit, better } = spec.descriptor;
  const raw = unit === 'ratio' ? (value - before) * 100 : value - before;
  const rounded = unit === 'ratio' ? Math.round(raw * 10) / 10 : Math.round(raw);
  if (rounded === 0) return { text: 'No change', direction: 'same' };
  const size = Math.abs(rounded);
  const magnitude = unit === 'ratio' ? `${decimal.format(size)} pp` : unit === 'minutes' ? duration(size) : integers.format(size);
  const direction = better === 'none' ? 'neutral' : (better === 'lower') === (rounded < 0) ? 'better' : 'worse';
  return { text: `${rounded > 0 ? '+' : '−'}${magnitude}`, direction };
}

/** The first click on a column sorts worst first. */
export function firstSortAscending(spec: MetricSpec): boolean {
  return spec.descriptor.better === 'higher';
}

/** Missing values sort last in both directions. */
export function compareValues(ascending: boolean): (a: number | null, b: number | null) => number {
  return (a, b) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : ascending ? a - b : b - a;
}

/** The colour scale: heat where the metric has a better, so the worst is always red; neutral greys where it has none. */
export function bandScale(spec: MetricSpec): 'heat' | 'neutral' {
  return spec.descriptor.better === 'none' ? 'neutral' : 'heat';
}

/**
 * One of five bands, 0 best to 4 worst. Fixed by the descriptor's limits where it has them; otherwise relative to the
 * highest value shown. A metric where higher is better turns the scale round.
 */
export function bandOf(spec: MetricSpec, value: number, highest: number): number {
  const limits = spec.descriptor.bands;
  const higher = spec.descriptor.better === 'higher';
  // A limit belongs to the better side: at most 5 is the best complexity band, 90% is already the best coverage band.
  const step = limits ? (() => {
    const index = limits.findIndex(limit => higher ? value < limit : value <= limit);
    return index < 0 ? limits.length : index;
  })() : highest > 0 ? Math.min(4, Math.floor(value / highest * 5)) : 0;
  return higher ? 4 - step : step;
}

/** The legend's words, best band first; null where the bands are relative and the legend reads Lower … Higher. */
export function bandLabels(spec: MetricSpec): string[] | null {
  const limits = spec.descriptor.bands;
  if (!limits) return null;
  const unit = spec.descriptor.unit;
  const show = (value: number) => unit === 'ratio' ? `${+(value * 100).toFixed(1)}%` : unit === 'minutes' ? duration(value) : integers.format(value);
  const bare = (value: number) => show(value).replace(/%$/, '');
  let ranges: string[];
  if (unit === 'count') {
    ranges = [`≤${show(limits[0])}`, ...limits.slice(1).map((limit, index) => `${show(limits[index]! + 1)}–${show(limit)}`),
      `${show(limits[3] + 1)}+`];
  } else {
    const join = (low: number, high: number) => unit === 'ratio' ? `${bare(low)}–${show(high)}` : `${show(low)}–${show(high)}`;
    ranges = [`<${show(limits[0])}`, ...limits.slice(1).map((limit, index) => join(limits[index]!, limit)), `${show(limits[3])}+`];
  }
  return spec.descriptor.better === 'higher' ? ranges.reverse() : ranges;
}
