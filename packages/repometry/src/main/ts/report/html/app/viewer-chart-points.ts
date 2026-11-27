import type { ProfileBoundary } from '../../json/wire/inspection-context-model.js';
import { line, setAttributes, svgNode } from './viewer-chart-svg.js';
import type { Layout } from './viewer-chart-svg.js';

export interface ChartPoint {
  readonly value: number | null;
  /** Axis label used only when the points have no commit times. */
  readonly label: string;
  /** Accessible name of the point. */
  readonly title: string;
  readonly href: string;
  readonly current: boolean;
  readonly partial: boolean;
  readonly boundary?: ProfileBoundary | null;
  /** Commit time in milliseconds; the x axis is a time scale when every point has one. */
  readonly time: number | null;
  /** Hover card lines: a heading, then details. */
  readonly tip: ChartTip;
  /** A green flag on the best value of the series, a red one at half-mast on the worst. */
  readonly flag?: 'best' | 'worst' | undefined;
}

export interface ChartTip {
  readonly heading: string;
  readonly commit: string;
  /** The commit's message, first line: what the chart's step was. */
  readonly subject?: string;
  readonly value: string;
  readonly change?: { readonly text: string; readonly direction: string } | null;
  readonly notes: readonly string[];
}

export type Flag = NonNullable<ChartPoint['flag']>;

/** The values the points measured, in order, without the gaps. */
export function measuredValues(values: readonly (number | null)[]): number[] {
  return values.flatMap(value => value === null ? [] : [value]);
}

/**
 * The measured points joined into one line: an inspection with no value is skipped, not a break, since most commits
 * import no coverage; a profile change does not cut the line either. Fewer than two measurements draw no line.
 */
export function segments(values: readonly (number | null)[]): number[][] {
  const run = values.flatMap((value, index) => value === null ? [] : [index]);
  return run.length > 1 ? [run] : [];
}

/**
 * Code keeps its state until the next commit, so the line holds each value and steps at the commit that changed it;
 * a slope would invent values for the days between commits. A run of equal values is one horizontal stroke, so ten
 * thousand quiet commits cost a single segment.
 */
export function stepPath(segment: readonly number[], valueAt: (index: number) => number, x: (index: number) => number,
  y: (value: number) => number): string {
  return segment.map((index, order) => {
    const value = valueAt(index);
    if (!order) return `M${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    const last = order === segment.length - 1;
    return value === valueAt(segment[order - 1]!) && !last ? '' : `H${x(index).toFixed(1)}V${y(value).toFixed(1)}`;
  }).join('');
}

/** A dashed line where the profile changed between two inspections. */
export function markBoundaries(svg: SVGSVGElement, layout: Layout, points: readonly ChartPoint[]): void {
  for (const [index, point] of points.entries()) {
    if (index === 0 || !point.boundary) continue;
    const x = layout.xs[index]!;
    svg.append(line(`tc-profile-${point.boundary}`, { x1: x, x2: x, y1: layout.top, y2: layout.top + layout.plotHeight }));
  }
}

/** A tiny flag planted in the point: the pennant of the logo on a short pole, both in the flag's colour. */
export function flagMark(kind: Flag, x: number, y: number): SVGGElement {
  const group = svgNode('g', `tc-flag tc-flag-${kind}`);
  const foot = y - 4;
  const head = foot - 12;
  const pole = svgNode('rect');
  setAttributes(pole, { x: x - .75, y: head, width: 1.5, height: foot - head });
  const pennant = svgNode('path');
  pennant.setAttribute('d', `M${(x + .75).toFixed(1)},${head.toFixed(1)}L${(x + 10).toFixed(1)},${(head - .4).toFixed(1)}L${(x + .75).toFixed(1)},${(head + 5.5).toFixed(1)}Z`);
  group.append(pole, pennant);
  return group;
}

export function flagIcon(kind: Flag): SVGSVGElement {
  const icon = svgNode('svg', `tc-flag tc-flag-${kind}`);
  icon.setAttribute('viewBox', '0 -1 11 14');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(flagMark(kind, 1, 16));
  return icon;
}

/** A point's link to its commit, which holds its marks. */
export function pointLink(point: ChartPoint, index: number): SVGAElement {
  const link = svgNode('a', 'tc-point');
  link.setAttribute('href', point.href);
  link.setAttribute('aria-label', point.title);
  link.dataset.index = String(index);
  if (point.current) link.setAttribute('aria-current', 'true');
  return link;
}
