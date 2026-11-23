// The commit picker: a search field over the inspected commits, since a history of thousands cannot be a select.
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';

const shown = 50;
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export interface CommitMatch {
  readonly entry: PublicHistoryEntry;
  readonly index: number;
}

interface Indexed {
  readonly entry: PublicHistoryEntry;
  readonly sha: string;
  readonly tags: readonly string[];
  /** Everything else a person may type: subject, tags, author, and the date in ISO and local form. */
  readonly text: string;
}

export function commitIndex(entries: readonly PublicHistoryEntry[]): readonly Indexed[] {
  return entries.map(entry => {
    const time = when(entry);
    const tags = (entry.tags ?? []).map(tag => tag.toLowerCase());
    const text = [entry.subject ?? '', ...tags, entry.author?.name ?? '', entry.author?.email ?? '',
      time === null ? '' : new Date(time).toISOString().slice(0, 10), time === null ? '' : day.format(new Date(time))]
      .join('\n').toLowerCase();
    return { entry, sha: entry.sha.toLowerCase(), tags, text };
  });
}

/**
 * Commits matching every word of the query, in history order, with exact tags and hash prefixes first. A hash
 * matches from its start only, so "a1" does not match every commit that merely contains it.
 */
export function searchCommits(index: readonly Indexed[], query: string, limit = shown): { matches: CommitMatch[]; total: number } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const exact: CommitMatch[] = [];
  const rest: CommitMatch[] = [];
  let total = 0;
  for (const [position, item] of index.entries()) {
    if (!words.every(word => item.sha.startsWith(word) || item.text.includes(word))) continue;
    total += 1;
    const strong = words.length > 0 && words.some(word => item.tags.includes(word) || (word.length >= 4 && item.sha.startsWith(word)));
    const bucket = strong ? exact : rest;
    if (exact.length + rest.length < limit || strong) bucket.push({ entry: item.entry, index: position });
  }
  return { matches: [...exact, ...rest].slice(0, limit), total };
}

export interface CommitPicker {
  set(sha: string): void;
  hidden: boolean;
}

/**
 * Renders the picker into the slot; picking a commit calls back with its SHA. The branch, when the configuration names
 * one, heads the field: the commits are that branch's history.
 */
export function createCommitPicker(slot: HTMLElement, entries: readonly PublicHistoryEntry[], pick: (sha: string) => void,
  branch?: string): CommitPicker {
  const index = commitIndex(entries);
  const bySha = new Map(entries.map(entry => [entry.sha, entry]));
  const searchable = entries.some(entry => entry.subject || entry.author || entry.tags?.length);
  let current = entries[0]!.sha;
  let active = 0;
  let matches: CommitMatch[] = [];

  // One control: the field shows the selected commit and, once focused, takes the search; the list opens attached
  // under it, inside the same frame.
  const field = element('div', 'commit-field');
  const input = element('input', 'commit-search');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = searchable ? 'Message, tag, author, date or hash' : 'Hash or date';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const shown = element('span', 'commit-current');
  shown.setAttribute('aria-hidden', 'true');
  // The selected commit is drawn over the empty input, so both share one box after the branch.
  const entry = element('span', 'commit-entry');
  entry.append(input, shown);
  if (branch) {
    const name = element('span', 'commit-branch', branch);
    name.title = `Branch ${branch}`;
    name.setAttribute('aria-hidden', 'true');
    field.append(name);
  }
  field.append(entry);
  const popover = element('div', 'commit-popover');
  popover.hidden = true;
  const list = element('ul', 'commit-options');
  list.id = 'commit-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commits');
  input.setAttribute('aria-controls', list.id);
  const status = element('p', 'commit-status');
  status.setAttribute('aria-live', 'polite');
  popover.append(list, status);
  slot.replaceChildren(field, popover);

  function label(): void {
    const entry = bySha.get(current)!;
    const time = when(entry);
    shown.replaceChildren(element('span', 'commit-hash', entry.sha.slice(0, 7)),
      element('span', 'commit-current-text', entry.subject ?? (time === null ? '' : dayTime.format(new Date(time)))));
    field.title = [entry.sha, entry.subject].filter(Boolean).join('\n');
    input.setAttribute('aria-label', `${branch ? `Branch ${branch}, commit` : 'Commit'} ${entry.sha.slice(0, 7)}${entry.subject ? `: ${entry.subject}` : ''}. Type to search commits`);
  }

  function update(): void {
    const result = searchCommits(index, input.value);
    matches = result.matches;
    active = Math.max(0, matches.findIndex(match => match.entry.sha === current));
    if (input.value.trim()) active = 0;
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list.replaceChildren(...matches.map((match, position) => option(match.entry, position, words)));
    status.textContent = result.total === 0 ? `No commits match “${input.value.trim()}”`
      : result.total > matches.length ? `${matches.length} of ${result.total.toLocaleString()} ${input.value.trim() ? 'matches' : 'commits'} · type to narrow`
      : `${result.total.toLocaleString()} ${result.total === 1 ? 'commit' : 'commits'}${branch && !input.value.trim() ? ` on ${branch}` : ''}`;
    highlight();
  }

  function option(entry: PublicHistoryEntry, position: number, words: readonly string[]): HTMLLIElement {
    const item = element('li', 'commit-option');
    item.id = `commit-option-${position}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(entry.sha === current));
    const time = when(entry);
    const head = element('span', 'commit-option-head');
    head.append(marked('span', 'commit-hash', entry.sha.slice(0, 7), words, true),
      marked('span', 'commit-subject', entry.subject ?? (time === null ? '' : dayTime.format(new Date(time))), words));
    item.append(head);
    // The second line names who and when, then the tags: two fit, the rest fold into a count, and the tags the
    // search found come first. The email appears only when the search found it.
    const author = authorLabel(entry.author, words);
    const meta = [author, entry.subject && time !== null ? dayTime.format(new Date(time)) : null].filter(Boolean).join(' · ');
    const tags = [...entry.tags ?? []].sort((a, b) => Number(hit(b, words)) - Number(hit(a, words)));
    if (meta || tags.length) {
      const line = element('span', 'commit-option-meta');
      line.append(marked('span', 'commit-meta', meta, words));
      for (const tag of tags.slice(0, 2)) line.append(marked('span', 'commit-tag', tag, words));
      if (tags.length > 2) {
        const more = element('span', 'commit-tag commit-tag-more', `+${tags.length - 2}`);
        more.title = tags.slice(2).join('\n');
        line.append(more);
      }
      item.append(line);
    }
    item.addEventListener('mousedown', event => event.preventDefault());
    item.addEventListener('click', () => choose(entry.sha));
    item.addEventListener('mousemove', () => { if (active !== position) { active = position; highlight(); } });
    return item;
  }

  function highlight(): void {
    for (const [position, item] of [...list.children].entries()) item.classList.toggle('active', position === active);
    const item = list.children[active] as HTMLElement | undefined;
    if (item) {
      input.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  const isOpen = () => !popover.hidden;

  function open(): void {
    if (isOpen()) return;
    popover.hidden = false;
    slot.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    update();
    document.addEventListener('pointerdown', outside, true);
  }

  function close(): void {
    if (!isOpen()) return;
    popover.hidden = true;
    slot.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = '';
    document.removeEventListener('pointerdown', outside, true);
  }

  function outside(event: Event): void {
    if (!slot.contains(event.target as Node)) close();
  }

  function choose(sha: string): void {
    close();
    input.blur();
    if (sha !== current) pick(sha);
  }

  field.addEventListener('pointerdown', event => {
    if (event.target !== input) event.preventDefault();
    input.focus();
    open();
  });
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => { if (!slot.matches(':hover')) close(); });
  input.addEventListener('input', () => isOpen() ? update() : open());
  input.addEventListener('keydown', event => {
    const last = matches.length - 1;
    if (!isOpen() && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
      event.preventDefault();
      open();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = last < 0 ? 0 : (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      highlight();
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      active = Math.min(last, Math.max(0, active + (event.key === 'PageDown' ? 8 : -8)));
      highlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = matches[active];
      if (match) choose(match.entry.sha);
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  label();
  return {
    set(sha) {
      if (!bySha.has(sha)) return;
      current = sha;
      label();
    },
    get hidden() { return slot.hidden === true; },
    set hidden(value: boolean) {
      if (value) close();
      slot.hidden = value;
    },
  };
}

/**
 * How a commit's author reads in the list: the name, with the email only when the search found the email and not the
 * name. A history without emails carries the name alone, and then it is the name alone; nothing reads as missing.
 */
export function authorLabel(author: PublicHistoryEntry['author'], words: readonly string[]): string | null {
  if (!author?.name) return null;
  return author.email && hit(author.email, words) && !hit(author.name, words) ? `${author.name} <${author.email}>` : author.name;
}

function hit(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(word => lower.includes(word));
}

function when(entry: PublicHistoryEntry): number | null {
  const time = Date.parse(entry.committedAt ?? entry.generatedAt);
  return Number.isFinite(time) ? time : null;
}

/** Text with the typed words marked; a hash is marked only from its start, as it is matched. */
function marked(tag: 'span', className: string, text: string, words: readonly string[], prefixOnly = false): HTMLElement {
  const node = element(tag, className);
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words) {
    if (prefixOnly) {
      if (lower.startsWith(word)) ranges.push([0, word.length]);
      continue;
    }
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) node.append(text.slice(cursor, from));
    node.append(element('mark', '', text.slice(from, end)));
    cursor = end;
  }
  if (cursor < text.length) node.append(text.slice(cursor));
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
