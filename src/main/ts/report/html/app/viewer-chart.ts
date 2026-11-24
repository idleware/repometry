// Line and bar charts for the viewer. Drawn as SVG at the container's pixel width,
// so labels keep their size on every screen. Colours come from CSS classes and theme tokens.

import { barChart } from './viewer-chart-bars.js';
import type { BarOptions } from './viewer-chart-bars.js';
import { lineChart } from './viewer-chart-line.js';
import type { ChartOptions } from './viewer-chart-line.js';
import type { ChartPoint } from './viewer-chart-points.js';
import { plotBottom, plotTop, svgNode } from './viewer-chart-svg.js';
import type { Layout } from './viewer-chart-svg.js';
import { interact } from './viewer-chart-tip.js';

export type { ChartPoint } from './viewer-chart-points.js';

const observed = new WeakMap<Element, { width: number; draw: (width: number) => void }>();
const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
  for (const entry of entries) {
    const record = observed.get(entry.target);
    const width = Math.round(entry.contentRect.width);
    if (!record || width <= 0 || width === record.width) continue;
    record.width = width;
    record.draw(width);
  }
});

/** Draws into the container now and again whenever its width changes. */
function mount(container: HTMLElement, draw: (width: number) => void): void {
  const width = Math.round(container.clientWidth);
  observed.set(container, { width, draw });
  observer?.observe(container);
  draw(width || 640);
}

function chartHeight(compact: boolean): number {
  return compact ? 200 : 248;
}

export function renderLineChart(container: HTMLElement, points: readonly ChartPoint[], options: ChartOptions): void {
  const height = options.height ?? chartHeight(options.compact);
  mount(container, width => draw(container, points, width, height, (svg, layout) => lineChart(svg, layout, points, options)));
}

/** Diverging bars around zero, one per point; a point without a value gets a mark on the zero line. */
export function renderBarChart(container: HTMLElement, points: readonly ChartPoint[], options: BarOptions): void {
  mount(container, width => draw(container, points, width, chartHeight(options.compact), (svg, layout) => barChart(svg, layout, points, options)));
}

function draw(container: HTMLElement, points: readonly ChartPoint[], width: number, height: number,
  body: (svg: SVGSVGElement, layout: Layout) => void): void {
  const layout: Layout = { width, height, top: plotTop, plotHeight: height - plotTop - plotBottom, left: 0, plotWidth: 0, xs: [], ys: [] };
  const svg = svgNode('svg', 'tc');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  body(svg, layout);
  const tip = document.createElement('div');
  tip.className = 'tc-tip';
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  container.classList.add('chart-interactive');
  container.replaceChildren(svg, tip);
  interact(svg, tip, layout, points);
}
