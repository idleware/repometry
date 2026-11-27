/** The DOM building blocks every page of the viewer shares. */

const integer = new Intl.NumberFormat();
const percentFormat = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

/** Paths compare as people read them: numbers by value, so file10 follows file9. */
export const collator = new Intl.Collator(undefined, { numeric: true });

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

export function link(href: string, label: string, className?: string): HTMLAnchorElement {
  const result = element('a', className, label);
  result.href = href;
  return result;
}

/** A link that opens another site in a new tab, without handing it this page. */
export function externalLink(href: string, label: string, className?: string): HTMLAnchorElement {
  const result = link(href, label, className);
  result.target = '_blank';
  result.rel = 'noopener noreferrer';
  return result;
}

/** One row of a description list, with a quieter line of context under the value. */
export function fact(label: string, value: string, context?: string): HTMLElement {
  const pair = element('div');
  pair.append(element('dt', '', label), element('dd', '', value));
  if (context) pair.append(element('dd', 'fx-note', context));
  return pair;
}

/** A table that scrolls on its own, named so the region can be found and scrolled from the keyboard. */
export function scrollableTable(table: HTMLTableElement, label: string): HTMLElement {
  const region = element('div', 'table-scroll fx-table-scroll');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', label);
  region.tabIndex = 0;
  region.append(table);
  return region;
}

export function count(value: number | null | undefined): string {
  return value == null ? '—' : integer.format(value);
}

export function percent(value: number): string {
  return percentFormat.format(value);
}

export function quantity(amount: number, noun: string): string {
  return `${count(amount)} ${noun}${amount === 1 ? '' : 's'}`;
}

export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function inside(path: string, directory: string): boolean {
  return directory === '' || path.startsWith(`${directory}/`);
}

/** Whether any of the strings holds the lowercased query; an empty query holds everywhere. */
export function contains(query: string, strings: readonly (string | undefined)[]): boolean {
  return query === '' || strings.some(value => value?.toLowerCase().includes(query));
}

/** Storage that a private window or a blocked site refuses: reads fall back, writes are forgotten. */
export function stored(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

export function store(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Without storage the choice lasts for this page only.
  }
}

/** An element of the page by its id; the page's own markup holds every id the viewer asks for. */
export function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** A quiet status line in place of a container's content: loading, empty, or failed. */
export function notice(container: HTMLElement, text: string): void {
  const paragraph = document.createElement('p');
  paragraph.className = 'detail empty';
  paragraph.setAttribute('role', 'status');
  paragraph.textContent = text;
  container.replaceChildren(paragraph);
}
