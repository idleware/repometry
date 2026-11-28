// A series with its companion, as the Overview and the Trends page draw it, with a key that switches either line.
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';
import { renderLineChart } from './viewer-chart.js';
import type { ChartPoint } from './viewer-chart.js';
import { element, store, stored } from './viewer-dom.js';
import { formatMetric, isPercent, labelOf } from './viewer-metrics.js';
import type { Metric } from './viewer-metrics.js';
import { trendValue } from './viewer-trend-data.js';
import type { TrendData } from './viewer-trend-data.js';
import { seriesPoints, tickUnit, trendLegend } from './viewer-trend-points.js';

/** The measure drawn beside a series as a grey line on its own scale: the time behind the ratio, the lines behind the share. */
export const companions: Readonly<Partial<Record<Metric, Metric>>> = { debt: 'effort', coverage: 'uncovered-lines' };

const hiddenKey = 'repometry.hidden-series';
let hiddenSeries: Set<string> | undefined;

/** The lines switched off in the key, remembered for this viewer. */
function hidden(): Set<string> {
  if (hiddenSeries) return hiddenSeries;
  try {
    hiddenSeries = new Set(JSON.parse(stored(() => localStorage, hiddenKey) ?? '[]') as string[]);
  } catch {
    hiddenSeries = new Set();
  }
  return hiddenSeries;
}

const profileKey = 'repometry.profile-lines';

/** Whether the dashed lines at profile changes are drawn: off until the viewer switches them on, on both tabs. */
export function profileLines(): boolean {
  return stored(() => localStorage, profileKey) === 'on';
}

function remember(): void {
  store(() => localStorage, hiddenKey, JSON.stringify([...hidden()]));
}

export interface SeriesOptions {
  readonly compact: boolean;
  readonly height?: number | undefined;
  readonly labelCurrent?: boolean;
}

/** Where a series is drawn and what it draws: the chart and its key, the inspections shown, and the selected commit. */
export interface SeriesView {
  readonly chart: HTMLElement;
  readonly key: HTMLElement;
  /** Where the footnote goes; it follows the key's profile switch. */
  readonly note?: HTMLElement | undefined;
  readonly data: TrendData;
  readonly shown: readonly PublicHistoryEntry[];
  readonly metric: Metric;
  readonly selected: string;
  readonly link: (sha: string) => string;
}

/** The card under the pointer names the grey series too. */
function withCompanion(points: readonly ChartPoint[], second: readonly (number | null)[], pair: Metric): ChartPoint[] {
  return points.map((entry, index) => {
    const value = second[index];
    if (value == null) return entry;
    return { ...entry, tip: { ...entry.tip, notes: [`${labelOf(pair)}: ${formatMetric(value, pair)}`, ...entry.tip.notes] } };
  });
}

/** One entry of the key: pressed while its line shows; the one line left stays, since a chart of nothing says nothing. */
function keyItem(series: Metric, kind: 'main' | 'second', on: boolean, alone: boolean, toggle: () => void): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `trend-key-item trend-key-${kind}`;
  item.textContent = labelOf(series);
  item.setAttribute('aria-pressed', String(on));
  item.disabled = on && alone;
  item.addEventListener('click', toggle);
  return item;
}

/** The key's entry for the dashed lines at profile changes: a dashed swatch, struck through while they are off. */
export function profileSwitch(on: boolean, redraw: () => void): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'trend-key-item trend-key-profile';
  item.textContent = 'Profile changes';
  // The swatch is the key's own bar, painted as dashes.
  item.style.setProperty('--series', 'repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 7px)');
  item.setAttribute('aria-pressed', String(on));
  item.addEventListener('click', () => {
    store(() => localStorage, profileKey, on ? 'off' : 'on');
    redraw();
  });
  return item;
}

function emptySeries(chart: HTMLElement): void {
  chart.replaceChildren(element('p', 'detail empty', 'No measurements for this series in the shown inspections.'));
}

/**
 * A series with its companion, as the Overview draws it: the series in ink on the left scale, the companion in grey on
 * the right, and a key whose entries switch each line on and off. The last line shown cannot be switched off; with one
 * left it takes the left scale. The choice is remembered for this viewer. Returns whether anything was drawn.
 */
export function renderSeries(view: SeriesView, options: SeriesOptions): boolean {
  const { chart, key, note, data, shown, metric, selected, link } = view;
  const pair = companions[metric];
  const second = pair ? shown.map(report => trendValue(data, report, pair)) : [];
  // A companion earns its line only once it can draw one, that is, from two measurements on.
  const paired = pair !== undefined && second.filter(item => item !== null).length >= 2;
  const main = seriesPoints(data, shown, metric, selected, link);
  const hasData = main.some(entry => entry.value !== null) || (paired && second.some(item => item !== null));

  const changes = main.some(entry => entry.boundary);

  function draw(): void {
    const lines = profileLines();
    const showMain = !paired || !hidden().has(metric);
    const showSecond = paired && !hidden().has(pair!);
    const both = showMain && showSecond;
    const lead = showMain ? metric : pair!;
    const base = showMain ? main : seriesPoints(data, shown, pair!, selected, link);
    const points = both ? withCompanion(base, second, pair!) : base;
    chart.classList.toggle('chart-companion-only', !showMain);
    if (points.some(entry => entry.value !== null)) {
      renderLineChart(chart, points, { format: number => formatMetric(number, lead), ratio: isPercent(lead), compact: options.compact,
        height: options.height, tickUnit: tickUnit(points.map(entry => entry.value), lead), labelCurrent: options.labelCurrent ?? true, boundaries: lines,
        secondary: both ? { values: second, format: number => formatMetric(number, pair!), tickUnit: tickUnit(second, pair!) } : undefined });
    } else emptySeries(chart);
    if (note) {
      const text = trendLegend(main, lines);
      note.textContent = text;
      note.hidden = text === '';
    }
    key.hidden = !paired && !changes;
    const items = paired ? ([[metric, 'main', showMain], [pair!, 'second', showSecond]] as const).map(([series, kind, on]) =>
      keyItem(series, kind, on, !both, () => {
        if (on) hidden().add(series);
        else hidden().delete(series);
        remember();
        draw();
        key.querySelector<HTMLButtonElement>(`.trend-key-${kind}`)?.focus();
      })) : [];
    if (changes) {
      items.push(profileSwitch(lines, () => {
        draw();
        key.querySelector<HTMLButtonElement>('.trend-key-profile')?.focus();
      }));
    }
    key.replaceChildren(...items);
  }
  if (hasData) draw();
  else {
    chart.replaceChildren();
    key.hidden = true;
  }
  return hasData;
}

