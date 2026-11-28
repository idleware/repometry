/** The chart's SVG building blocks and the plot's layout, shared by its axes, marks and hover card. */

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly plotHeight: number;
  left: number;
  plotWidth: number;
  /** Horizontal position of each point. */
  xs: number[];
  /** Y of each point's mark, for the hover card. */
  ys: (number | null)[];
}

export const plotTop = 34;
export const plotBottom = 30;
export const plotRight = 18;
/** Keeps the first and last marks off the plot edges. */
export const inset = 12;

const svgNamespace = 'http://www.w3.org/2000/svg';

export function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNamespace, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

/** Sets numeric attributes, rounded to a tenth of a pixel. */
export function setAttributes(node: SVGElement, attributes: Record<string, number>): void {
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(Number(value.toFixed(1))));
}

export function text(content: string, className: string, x: number, y: number): SVGTextElement {
  const node = svgNode('text', className);
  node.textContent = content;
  setAttributes(node, { x, y });
  return node;
}

/** A label centred on its anchor. */
export function centredText(content: string, className: string, x: number, y: number): SVGTextElement {
  const node = text(content, className, x, y);
  node.setAttribute('text-anchor', 'middle');
  return node;
}

/** Where a centred label stands so that it stays inside the plot. */
export function clampLabel(x: number, label: string, { left, plotWidth }: Pick<Layout, 'left' | 'plotWidth'>): number {
  const half = label.length * 3.6 + 2;
  return Math.min(Math.max(x, left + half), left + plotWidth - half);
}

/** A line across the plot, at a height or at a point. */
export function line(className: string, attributes: Record<string, number>): SVGLineElement {
  const node = svgNode('line', className);
  setAttributes(node, attributes);
  return node;
}
