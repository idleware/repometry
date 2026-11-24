import type { Finding } from '../../json/wire/domain-types.js';
import { copyIcon, copyOnClick } from './viewer-copy.js';
import { element, externalLink, link, parentPath, quantity } from './viewer-dom.js';
import type { Navigation } from './viewer-inspection.js';
import { allLocations, formatLocation } from './viewer-locations.js';
import type { Location } from './viewer-locations.js';
import { duration } from './viewer-metrics.js';
import { lineSnippet, renderExcerpt } from './viewer-source-view.js';
import { highlightCode } from './viewer-tokenizer.js';

export const issueCategories: Readonly<Record<string, string>> = {
  structure: 'Structure', duplication: 'Duplication', lint: 'Lint', security: 'Security',
  dependency: 'Dependencies', secret: 'Secrets', infrastructure: 'Infrastructure',
};
export const issueLevels = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' } as const;
export const levelOrder = { high: 0, medium: 1, low: 2, unknown: 3 } as const;

/** The work a set of findings asks for, where any of them states it. */
export function effortOf(findings: readonly Finding[]): number | undefined {
  if (!findings.some(item => item.effortMinutes !== undefined)) return undefined;
  return findings.reduce((sum, item) => sum + (item.effortMinutes ?? 0), 0);
}

/** A tool, a rule or a path with nothing in it, or a line break, would make an entry the profile cannot read back. */
function plain(value: string): boolean {
  return value.trim() !== '' && !/[\0\r\n]/.test(value);
}

/** A path the ignore entry can match literally: relative, normalised, with no glob or drive in it. */
export function literalPath(path: string | undefined): path is string {
  if (!path || /[\0\r\n\\*?{}[\]()]/.test(path) || /^[#!]|^[a-z]:/i.test(path)) return false;
  return path.split('/').every(part => part && part !== '.' && part !== '..');
}

/** The profile entry that ignores a finding: in its file where the path can be matched literally, else everywhere. */
export function ignoreRecord(finding: Pick<Finding, 'tool' | 'rule' | 'path'>): { tool: string; rule: string; path?: string } | undefined {
  const { tool, rule, path } = finding;
  if (!plain(tool) || !plain(rule)) return undefined;
  return { tool, rule, ...(literalPath(path) ? { path } : {}) };
}

function ignoreSnippet(finding: Finding): HTMLDetailsElement | undefined {
  const record = ignoreRecord(finding);
  if (!record) return undefined;
  const details = element('details', 'fx-ignore');
  const title = element('summary', '', 'Ignore rule');
  const hint = element('p', 'fx-note', 'Add this entry to the profile’s ignore array and rerun the inspection. '
    + (record.path ? 'It matches this rule in the file shown.' : 'It matches this rule across the repository.'));
  const input = element('textarea', 'fx-ignore-code');
  input.readOnly = true;
  input.rows = Object.keys(record).length + 2;
  input.wrap = 'off';
  input.value = JSON.stringify(record, null, 2);
  input.setAttribute('aria-label', 'Profile ignore rule JSON');
  const copy = element('button', 'fx-copy');
  copy.type = 'button';
  copy.title = 'Copy rule';
  copy.setAttribute('aria-label', 'Copy rule');
  copy.append(copyIcon());
  const feedback = element('p', 'fx-note fx-copy-status');
  feedback.setAttribute('role', 'status');
  copyOnClick(copy, () => input.value, {
    copied: () => {
      copy.title = 'Copied';
      feedback.textContent = 'Copied.';
      feedback.classList.add('visually-hidden');
    },
    reset: () => {
      copy.title = 'Copy rule';
      feedback.textContent = '';
    },
    refused: () => {
      input.focus();
      input.select();
      feedback.classList.remove('visually-hidden');
      feedback.textContent = 'Rule selected. Press your copy shortcut.';
    },
  });
  const code = element('div', 'fx-ignore-box');
  code.append(input, copy);
  details.append(title, hint, code, feedback);
  return details;
}

interface GroupContext {
  readonly navigation: Navigation;
  /** The files of the inspection, which links can open. */
  readonly files: ReadonlySet<string>;
}

/** A place as a link into its file where the inspection has the file, else as plain code. */
function placeLink(location: Location, context: GroupContext, label: string, className: string, plainClass: string): HTMLElement {
  if (!context.files.has(location.path)) return element('code', plainClass, label);
  return link(context.navigation.href('metrics', { directory: parentPath(location.path), file: location.path,
    ...(location.line ? { line: location.line } : {}) }), label, className);
}

/** Where the excerpt cannot load, the forge's page is one link away; without one, no gap is left. */
function excerptAway(slot: HTMLElement, place: Location & { readonly line: number }, context: GroupContext): void {
  const page = context.navigation.sourcePage?.(place.path, place.line);
  if (!page) {
    slot.remove();
    return;
  }
  slot.replaceChildren(externalLink(page.href, `View on ${page.provider}`, 'fx-source-forge'));
  slot.classList.add('fx-occurrence-away');
}

/** The lines a finding points at, loaded on demand; an anonymous function is named by its first line's code. */
function excerpt(finding: Finding, place: Location & { readonly line: number }, message: HTMLElement, context: GroupContext,
  source: (path: string) => Promise<string | null>): HTMLElement {
  const slot = element('div', 'fx-occurrence-code');
  void source(place.path).then(text => {
    if (text === null) {
      excerptAway(slot, place, context);
      return;
    }
    slot.append(renderExcerpt(text, { path: place.path, line: place.line, endLine: place.endLine,
      more: line => context.navigation.href('metrics', { directory: parentPath(place.path), file: place.path, line }) }));
    // A tool that could not name the function said "(anonymous)"; its first line says which one it is.
    const snippet = lineSnippet(text, place.line, 48);
    if (!snippet || !finding.message.startsWith('(anonymous)')) return;
    const name = element('code', 'fx-occurrence-name');
    name.append(...highlightCode(place.path, snippet));
    message.replaceChildren(name, finding.message.slice('(anonymous)'.length));
  });
  return slot;
}

function otherPlaces(places: readonly Location[], context: GroupContext): HTMLElement[] {
  if (!places.length) return [];
  const paths = element('ul', 'fx-event-paths');
  paths.append(...places.map(location => {
    const item = element('li');
    const label = formatLocation(location);
    item.append(context.files.has(location.path) ? placeLink(location, context, `Also ${label}`, 'fx-inline-link', 'fx-path')
      : element('code', 'fx-path', label));
    return item;
  }));
  return [paths];
}

/** Each occurrence is bound to its code: the place, the message, and the lines themselves. */
function occurrence(finding: Finding, context: GroupContext): HTMLLIElement {
  const row = element('li', 'fx-occurrence');
  const [primary, ...others] = allLocations(finding);
  const head = element('div', 'fx-occurrence-head');
  if (primary) head.append(placeLink(primary, context, formatLocation(primary), 'fx-location', 'fx-location'));
  if (finding.effortMinutes !== undefined) head.append(element('span', 'fx-occurrence-effort', duration(finding.effortMinutes)));
  const message = element('p', 'fx-occurrence-message', finding.message);
  row.append(head, message);
  const source = context.navigation.source;
  const line = primary?.line;
  if (primary && line !== undefined && context.files.has(primary.path) && source) row.append(excerpt(finding, { ...primary, line }, message, context, source));
  row.append(...otherPlaces(others, context));
  const ignore = ignoreSnippet(finding);
  if (ignore) row.append(ignore);
  return row;
}

/** The findings of one rule as a group that opens to its occurrences. */
export function issueGroup(group: readonly Finding[], navigation: Navigation, files: ReadonlySet<string>): HTMLDetailsElement {
  const item = group[0]!;
  const details = element('details', 'fx-issue');
  const summary = element('summary', 'fx-issue-summary');
  const identity = element('span');
  identity.append(element('strong', '', item.rule), element('span', 'fx-note', `${item.tool} · ${issueCategories[item.category] ?? item.category}`));
  const severity = element('span', 'fx-state', issueLevels[item.level]);
  severity.dataset.state = item.level;
  const effort = effortOf(group);
  const occurrences = quantity(group.length, 'occurrence');
  summary.append(identity, severity, element('span', 'fx-issue-count', effort === undefined ? occurrences : `${occurrences} · ${duration(effort)}`));
  const locations = element('ul', 'fx-event-list fx-occurrences');
  // The excerpts mark their lines in the finding's own colour, as its severity badge does.
  locations.dataset.level = item.level;
  // The occurrences, and the source they load, are built when the group is first opened: a page of closed groups
  // requests nothing.
  const context = { navigation, files };
  details.addEventListener('toggle', () => {
    if (details.open && !locations.childElementCount) locations.append(...group.map(finding => occurrence(finding, context)));
  });
  details.append(summary, locations);
  return details;
}
