import { valueLabel } from './viewer-chart-label.js';
import type { LabelContext } from './viewer-chart-label.js';
import { flagMark, markBoundaries, measuredValues, pointLink, segments, stepPath } from './viewer-chart-points.js';
import type { ChartPoint } from './viewer-chart-points.js';
import { niceStep, yAxis } from './viewer-chart-scale.js';
import { setAttributes, svgNode } from './viewer-chart-svg.js';
import type { Layout } from './viewer-chart-svg.js';
import { placeX } from './viewer-chart-x.js';

export interface ChartOptions {
  readonly format: (value: number) => string;
  /** Values are ratios within [0, 1]. */
  readonly ratio: boolean;
  readonly compact: boolean;
  /** Ticks fall on whole multiples of this unit, for example 60 to tick minutes in whole hours. */
  readonly tickUnit?: number;
  /** Label the selected point's value; off where the page already shows it next to the chart. */
  readonly labelCurrent?: boolean;
  /** Overall height in pixels, where the layout needs the chart to fill a given space. */
  readonly height?: number | undefined;
  /** A second series drawn as a grey line behind the first, on its own scale labelled at the right edge. */
  readonly secondary?: SecondarySeries | undefined;
  /** Draw a dashed line where the inspection profile changed; off unless asked for. */
  readonly boundaries?: boolean;
}

export interface SecondarySeries {
  /** One value per point, in the same order. */
  readonly values: readonly (number | null)[];
  readonly format: (value: number) => string;
  /** Ticks fall on whole multiples of this unit, as for the main series. */
  readonly tickUnit?: number;
}

/**
 * The second scale starts at zero and shares the main grid lines: each line carries one round value of each. Its top
 * is known once the main axis has settled how many lines there are.
 */
function secondScale(secondary: SecondarySeries) {
  const values = measuredValues(secondary.values);
  const scale = { high: 0, labels: undefined as ((ticks: number) => readonly string[]) | undefined };
  if (!values.length) return scale;
  scale.labels = ticks => {
    const unit = secondary.tickUnit ?? 1;
    const step = niceStep(Math.max(...values, 0) / unit / Math.max(1, ticks - 1)) * unit;
    scale.high = step * (ticks - 1);
    return Array.from({ length: ticks }, (_, index) => index === 0 ? '0' : secondary.format(step * index));
  };
  return scale;
}

function drawSecondary(svg: SVGSVGElement, layout: Layout, secondary: SecondarySeries, high: number, x: (index: number) => number): void {
  const y = (value: number) => layout.top + layout.plotHeight - value / high * layout.plotHeight;
  for (const segment of segments(secondary.values)) {
    const path = svgNode('path', 'tc-line tc-line-secondary');
    path.setAttribute('d', stepPath(segment, index => secondary.values[index]!, x, y));
    svg.append(path);
  }
}

/**
 * A dot per commit is noise once commits sit close together: the line carries the curve, and a dot marks only what
 * says something (the selected and the last commit, flags, and a lone measurement with no line to join). A profile
 * change is no reason for a dot, and an inspection without a value gets none.
 * Hover and the keyboard move one dot along the line instead. Only a short, sparse series keeps a dot per commit.
 */
export function marked(points: readonly ChartPoint[], index: number, sparse: boolean): boolean {
  const point = points[index]!;
  if (point.value === null) return false;
  if (sparse || point.current || index === points.length - 1 || point.flag) return true;
  return points.filter(entry => entry.value !== null).length < 2;
}

function pointMarks(point: ChartPoint, cx: number, cy: number): SVGElement[] {
  const dot = svgNode('circle', point.current ? 'tc-dot tc-dot-current' : 'tc-dot');
  if (point.partial) dot.classList.add('tc-dot-partial');
  setAttributes(dot, { cx, cy, r: point.current ? 5 : 3.5 });
  return point.flag ? [flagMark(point.flag, cx, cy), dot] : [dot];
}

/** Each marked point's dot, flag or gap mark, and the one value the chart labels. */
function drawMarks(svg: SVGSVGElement, layout: Layout, points: readonly ChartPoint[],
  { format, labelCurrent, y }: { format: (value: number) => string; labelCurrent: boolean; y: (value: number) => number }): void {
  const x = (index: number) => layout.xs[index]!;
  const axis = layout.top + layout.plotHeight;
  const sparse = points.length <= 12 && layout.xs.every((at, index) => index === 0 || at - layout.xs[index - 1]! >= 24);
  // One value is labelled: the selected commit's, or the last one when the selection is off the chart.
  const selectedIndex = points.findIndex(point => point.current && point.value !== null);
  const labelled = labelCurrent && selectedIndex >= 0 ? selectedIndex : points.length - 1;
  const context: LabelContext = { points, x, y, format, axis };
  for (const [index, point] of points.entries()) {
    if (!marked(points, index, sparse)) continue;
    const link = pointLink(point, index);
    link.append(...pointMarks(point, x(index), y(point.value!)));
    if (index === labelled) link.append(valueLabel(context, index));
    svg.append(link);
  }
}

export function lineChart(svg: SVGSVGElement, layout: Layout, points: readonly ChartPoint[],
  { format, ratio, compact, tickUnit = 1, labelCurrent = true, secondary, boundaries = false }: ChartOptions): void {
  const second = secondary && secondScale(secondary);
  const y = yAxis(svg, layout, { values: measuredValues(points.map(point => point.value)), ratio, count: compact ? 3 : 4, format, tickUnit,
    zero: false, rightLabels: second?.labels });
  placeX(svg, layout, points);
  const x = (index: number) => layout.xs[index]!;
  if (boundaries) markBoundaries(svg, layout, points);
  if (secondary && second!.high > 0) drawSecondary(svg, layout, secondary, second!.high, x);
  for (const segment of segments(points.map(point => point.value))) {
    const path = svgNode('path', 'tc-line');
    path.setAttribute('d', stepPath(segment, index => points[index]!.value!, x, y));
    svg.append(path);
  }

  layout.ys = points.map(point => point.value === null ? null : y(point.value));
  drawMarks(svg, layout, points, { format, labelCurrent, y });
}
