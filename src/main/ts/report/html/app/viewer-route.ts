import { isPeriod, isTrendView } from './viewer-trend-data.js';
import type { Period, TrendView } from './viewer-trend-data.js';

export const pages = ['overview', 'metrics', 'hotspots', 'trends', 'issues', 'diagnostics', 'settings', 'pulls'] as const;
export type Page = typeof pages[number];
export type FilePage = 'metrics' | 'hotspots' | 'issues' | 'diagnostics';

/** Where the viewer is: a page at a commit, and what the page shows there. */
export interface Route {
  page: Page;
  sha: string;
  directory?: string;
  file?: string;
  view?: TrendView;
  period?: Period;
  /** Metrics query and grouping. */
  query?: string;
  group?: string;
  /** A source line in an open file. */
  line?: number;
  /** Issues filters: finding categories, comma-separated, and a severity. */
  category?: string;
  level?: string;
  /** What Hotspots ranks by. */
  rank?: string;
  /** What an open file's lines show: findings, or coverage. */
  layer?: string;
}

/** The route's parts by their names in the URL, in the order the URL lists them. */
const parameters = [['directory', 'dir'], ['file', 'file'], ['view', 'view'], ['period', 'period'], ['query', 'q'], ['group', 'group'],
  ['line', 'line'], ['category', 'category'], ['level', 'level'], ['rank', 'rank'], ['layer', 'layer']] as const;

export function href(route: Route): string {
  const params = new URLSearchParams({ sha: route.sha });
  for (const [key, name] of parameters) {
    const value = route[key];
    if (value) params.set(name, String(value));
  }
  // Category lists read as written: category=structure,duplication.
  return `#${route.page}?${params.toString().replaceAll('%2C', ',')}`;
}

export function isFilePage(page: Page): page is FilePage {
  return page === 'metrics' || page === 'hotspots' || page === 'issues' || page === 'diagnostics';
}

/** Every page but pull requests reads the inspection's details, and the tabs need them where the summary has no counts. */
export function needsDetails(page: Page, counted: boolean): boolean {
  return isFilePage(page) || page === 'overview' || page === 'settings' || !counted;
}

/**
 * Reads the route from a location hash. A bare commit opens its Overview; an unknown commit reads as the newest one.
 * Components became a grouping of Metrics, so old links land there.
 */
export function readRoute(hash: string, commits: ReadonlySet<string>, newest: string): Route {
  const [rawPage = '', query = ''] = hash.slice(1).split('?', 2);
  if (commits.has(rawPage)) return { page: 'overview', sha: rawPage };
  const params = new URLSearchParams(query);
  const named = params.get('sha') ?? '';
  const sha = commits.has(named) ? named : newest;
  if (rawPage === 'components') return { page: 'metrics', sha, group: 'components' };
  const optional = (name: string) => params.get(name) ?? undefined;
  const view = optional('view');
  const period = optional('period');
  const line = Number(params.get('line'));
  return {
    page: pages.find(candidate => candidate === rawPage) ?? 'overview',
    sha,
    directory: optional('dir'),
    file: optional('file'),
    view: isTrendView(view) ? view : undefined,
    period: isPeriod(period) ? period : undefined,
    query: optional('q'),
    group: optional('group'),
    line: line > 0 ? line : undefined,
    category: optional('category'),
    level: optional('level'),
    rank: optional('rank'),
    layer: optional('layer'),
  };
}
