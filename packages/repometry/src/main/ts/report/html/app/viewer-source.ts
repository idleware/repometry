// Source text for a file at a commit, fetched where the export says it can be had, and the file's page on its forge.
import type { SourceLocator } from '../../json/wire/summary-model.js';

/** Where the viewer fetches a file's text, as the export names it: a URL template and the page a person would open. */
export type { SourceLocator } from '../../json/wire/summary-model.js';

export interface SourcePlace {
  readonly revision: string;
  readonly path: string;
  readonly line?: number | undefined;
}

/**
 * Fills a locator's template. A path keeps its slashes under {path} and loses them under {path:component}, as the
 * GitLab API wants. A fragment that names {line} is dropped when there is no line, so the link opens the file.
 */
export function expandLocator(template: string, { revision, path, line }: SourcePlace): string {
  const hash = template.indexOf('#');
  const fragment = hash < 0 ? '' : template.slice(hash);
  const base = hash < 0 ? template : template.slice(0, hash);
  const kept = line === undefined && fragment.includes('{line}') ? '' : fragment;
  const values: Readonly<Record<string, string>> = {
    revision: encodeURIComponent(revision),
    'path:component': encodeURIComponent(path),
    path: path.split('/').map(encodeURIComponent).join('/'),
    line: String(line),
  };
  return (base + kept).replace(/\{(revision|path:component|path|line)\}/g, (_, name: string) => values[name]!);
}

/** A locator the viewer can use: a fetch URL that is web or site-relative, and a page link only over http(s). */
export function sourceLocator(value: unknown): SourceLocator | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { provider, url, web } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof url !== 'string' || !url.includes('{path')) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return undefined;
  return { provider, url, ...(typeof web === 'string' && /^https?:\/\//i.test(web) ? { web } : {}) };
}

const providerNames: Readonly<Record<string, string>> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea' };
let locator: SourceLocator | undefined;
const requests = new Map<string, Promise<string | null>>();

/** The export's locator, from the summary; none means the report has no source navigation. */
export function useSources(value: SourceLocator | undefined): void {
  locator = value;
}

/**
 * The file's text at the commit, or null when it cannot be had: no locator, a private repository, a commit that was
 * never pushed, a network failure. Nothing is requested until a file or an excerpt opens; each URL is fetched once.
 */
export function loadSource(sha: string, path: string): Promise<string | null> {
  if (!locator) return Promise.resolve(null);
  const url = expandLocator(locator.url, { revision: sha, path });
  let request = requests.get(url);
  if (!request) {
    request = fetch(url).then(response => response.ok ? response.text() : null).catch(() => null);
    requests.set(url, request);
  }
  return request;
}

/** The page that shows the file on its forge, when the export names one. */
export function sourcePage(sha: string, path: string, line?: number): { readonly href: string; readonly provider: string } | null {
  if (!locator?.web) return null;
  const name = providerNames[locator.provider.toLowerCase()] ?? locator.provider.charAt(0).toUpperCase() + locator.provider.slice(1);
  return { href: expandLocator(locator.web, { revision: sha, path, line }), provider: name };
}
