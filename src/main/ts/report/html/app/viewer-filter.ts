// The Metrics query: one field of chips over files. Languages, components, measurements and paths share one grammar,
// so a selection reads as text, travels in the URL and comes back as chips.
import type { FileMetricsReport } from '../../json/wire/file-metrics-model.js';
import { labelOf } from './viewer-metrics.js';

type FileEntry = FileMetricsReport['files'][number];

type BuiltinMeasure = 'complexity' | 'cognitive' | 'lines' | 'functions' | 'coverage' | 'duplication' | 'remediation' | 'changes';
/** A built-in measure, or another plugin's metric by its registry key. */
export type Measure = string;
export type Operator = '>' | '>=' | '<' | '<=' | '=';

export type Clause =
  | { readonly kind: 'lang'; readonly value: string }
  | { readonly kind: 'component'; readonly value: string }
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'measure'; readonly measure: Measure; readonly operator: Operator; readonly value: number }
  | { readonly kind: 'has'; readonly value: 'findings' | 'diagnostics' }
  /** Whether a plugin read the file: `ignored:yes` lists what is only counted, lockfiles aside. */
  | { readonly kind: 'analysed'; readonly value: 'yes' | 'no' }
  /** Generated dependency lockfiles: `lockfile:yes`. */
  | { readonly kind: 'lockfile'; readonly value: 'yes' | 'no' };

/** What a file brings to the query beyond its metrics: the components it belongs to and its open findings. */
export interface FileFacts {
  readonly components: ReadonlyMap<string, readonly string[]>;
  readonly findings: ReadonlyMap<string, number>;
}

export interface MeasureSpec {
  readonly label: string;
  readonly percent?: boolean;
  readonly minutes?: boolean;
  read(entry: FileEntry): number | null;
}

const measures: Record<BuiltinMeasure, MeasureSpec> = {
  complexity: { label: labelOf('complexity'), read: entry => entry.complexity?.maximum ?? null },
  cognitive: { label: labelOf('cognitive'), read: entry => entry.quality?.cognitiveComplexity ?? null },
  lines: { label: labelOf('code-lines'), read: entry => entry.quality?.codeLines ?? entry.lines },
  functions: { label: 'Functions', read: entry => entry.functions },
  coverage: { label: labelOf('coverage'), percent: true,
    read: entry => entry.lineCoverage && entry.lineCoverage.total > 0 ? entry.lineCoverage.covered / entry.lineCoverage.total : null },
  duplication: { label: 'Duplication', percent: true, read: entry => {
    const duplication = entry.quality?.duplication;
    return duplication && duplication.codeLines > 0 ? duplication.duplicatedLines / duplication.codeLines : null;
  } },
  remediation: { label: labelOf('effort'), minutes: true, read: entry => entry.quality?.maintainability?.effortMinutes ?? null },
  changes: { label: 'Git changes', read: entry => entry.quality?.churn ?? null },
};

/** Other plugins' metrics, by key, for the inspection on screen. */
let pluginMeasures = new Map<string, MeasureSpec>();

export function usePluginMeasures(entries: Iterable<readonly [string, MeasureSpec]>): void {
  pluginMeasures = new Map(entries);
}

function measureOf(name: string): MeasureSpec | undefined {
  return name in measures ? measures[name as BuiltinMeasure] : pluginMeasures.get(name);
}

/**
 * Dependency lockfiles, by exact file name. They are generated, often the largest files in a repository, and no
 * plugin reads them: the language bar and the Metrics list give them a category of their own beside the ignored files.
 */
export const lockfileNames: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'flake.lock',
  'mix.lock', 'pubspec.lock', 'packages.lock.json', 'gradle.lockfile',
]);

/** Whether a path names a lockfile: its file name, at any depth, exactly as the tools write it. */
export function isLockfile(path: string): boolean {
  return lockfileNames.has(path.slice(path.lastIndexOf('/') + 1));
}

/** Whether no plugin read a file and it is not a lockfile: what the interface calls ignored. */
export function isIgnored(entry: Pick<FileEntry, 'path' | 'analysed'>): boolean {
  return entry.analysed === false && !isLockfile(entry.path);
}

/** The language bar's names for the two categories that are not languages. */
export const lockfilesLabel = 'Lockfiles';
export const ignoredLabel = 'Ignored';

/** What the language bar weighs: size in bytes, physical lines, or code lines. */
export type ShareMeasure = 'bytes' | 'lines' | 'code-lines';

/** Whether every file carries its size: inspections made before sizes were recorded carry none. */
export function sized(files: readonly Pick<FileEntry, 'bytes'>[]): boolean {
  return files.length > 0 && files.every(entry => entry.bytes !== undefined);
}

/**
 * What the language bar weighs, largest language first, then lockfiles, then the ignored files. Size in bytes when
 * every file has it: one measure for code, lockfiles and ignored files alike, untouched by formatting. Without sizes,
 * physical lines where any file is only counted (the one line measure all files have), otherwise code lines.
 */
export function languageShares(files: readonly Pick<FileEntry, 'path' | 'analysed' | 'lines' | 'quality' | 'bytes'>[]):
  { readonly measure: ShareMeasure; readonly shares: readonly (readonly [string, number])[] } {
  const measure: ShareMeasure = sized(files) ? 'bytes'
    : files.some(entry => entry.analysed === false || isLockfile(entry.path)) ? 'lines' : 'code-lines';
  const weightOf = (entry: (typeof files)[number]) => (measure === 'bytes' ? entry.bytes
    : measure === 'lines' ? entry.lines : entry.quality?.codeLines ?? entry.lines) ?? 0;
  const weights = new Map<string, number>();
  let lockfiles = 0;
  let ignored = 0;
  for (const entry of files) {
    if (isLockfile(entry.path)) lockfiles += weightOf(entry);
    else if (entry.analysed === false) ignored += weightOf(entry);
    else {
      const language = languageOf(entry.path);
      weights.set(language, (weights.get(language) ?? 0) + weightOf(entry));
    }
  }
  const shares: (readonly [string, number])[] = [...weights].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1]);
  if (lockfiles > 0) shares.push([lockfilesLabel, lockfiles]);
  if (ignored > 0) shares.push([ignoredLabel, ignored]);
  return { measure, shares };
}

/** Ready-made conditions offered before anything is typed: the questions people ask of a codebase most. */
const presets: readonly { readonly text: string; readonly label: string }[] = [
  { text: 'complexity>10', label: 'Complex functions' },
  { text: 'coverage<80%', label: 'Under 80% covered' },
  { text: 'duplication>0', label: 'Has duplication' },
  { text: 'remediation>0', label: 'Has technical debt' },
  { text: 'changes>0', label: 'Changed recently' },
  { text: 'has:findings', label: 'Has findings' },
];

const languages: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', swift: 'Swift', scala: 'Scala',
  vue: 'Vue', svelte: 'Svelte', sh: 'Shell', bash: 'Shell', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML',
};

/** Language colours follow the conventions people already know from code hosts. */
const languageColors: Readonly<Record<string, string>> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572a5', Go: '#00add8', Rust: '#dea584', Java: '#b07219',
  Kotlin: '#a97bff', Ruby: '#701516', PHP: '#4f5d95', 'C#': '#178600', C: '#555555', 'C++': '#f34b7d', Swift: '#f05138',
  Scala: '#c22d40', Vue: '#41b883', Svelte: '#ff3e00', Shell: '#89e051', CSS: '#663399', SCSS: '#c6538c', Less: '#1d365d',
  HTML: '#e34c26',
};

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return languages[extension] ?? (extension ? extension.toUpperCase() : 'Other');
}

export function languageColor(language: string): string {
  return languageColors[language] ?? 'var(--neutral-2)';
}

/** Splits the query into clauses; a word that names nothing known becomes a path fragment. */
export function parseQuery(text: string): Clause[] {
  const clauses: Clause[] = [];
  for (const match of text.matchAll(/(\w+):"([^"]*)"|(\S+)/g)) {
    const clause = match[1] ? keyed(match[1], match[2]!) : parseWord(match[3]!);
    if (clause) clauses.push(clause);
  }
  return clauses;
}

export function parseWord(word: string): Clause | null {
  const keyedWord = /^(\w+):(.+)$/.exec(word);
  if (keyedWord) return keyed(keyedWord[1]!, keyedWord[2]!);
  const condition = /^([\w.-]+)(>=|<=|>|<|=)(\d+(?:\.\d+)?)(%|h|min)?$/i.exec(word);
  if (condition) {
    const measure = condition[1]!.toLowerCase();
    const spec = measureOf(measure);
    if (!spec) return null;
    const number = Number(condition[3]);
    const unit = condition[4]?.toLowerCase();
    const value = spec.percent ? (unit === '%' || number > 1 ? number / 100 : number) : unit === 'h' ? number * 60 : number;
    return { kind: 'measure', measure, operator: condition[2] as Operator, value };
  }
  return word ? { kind: 'path', value: word } : null;
}

function keyed(key: string, value: string): Clause | null {
  switch (key.toLowerCase()) {
    case 'lang': case 'language': return { kind: 'lang', value };
    case 'component': return { kind: 'component', value };
    case 'path': case 'in': return { kind: 'path', value };
    case 'has': return value === 'findings' || value === 'diagnostics' ? { kind: 'has', value } : null;
    // The interface and the query call the files no plugin read "ignored"; `analysed:` stays as a silent alias.
    case 'analysed': case 'analyzed': return value === 'yes' || value === 'no' ? { kind: 'analysed', value } : null;
    case 'ignored': return value === 'yes' || value === 'no' ? { kind: 'analysed', value: value === 'yes' ? 'no' : 'yes' } : null;
    case 'lockfile': case 'lockfiles': return value === 'yes' || value === 'no' ? { kind: 'lockfile', value } : null;
    default: return null;
  }
}

export function formatQuery(clauses: readonly Clause[]): string {
  return clauses.map(clauseText).join(' ');
}

export function clauseText(clause: Clause): string {
  const quoted = (value: string) => /\s|"/.test(value) ? `"${value.replaceAll('"', '')}"` : value;
  switch (clause.kind) {
    case 'lang': return `lang:${quoted(clause.value)}`;
    case 'component': return `component:${quoted(clause.value)}`;
    case 'path': return /^\w+:|[<>=]/.test(clause.value) || /\s/.test(clause.value) ? `path:${quoted(clause.value)}` : clause.value;
    case 'has': return `has:${clause.value}`;
    case 'analysed': return `ignored:${clause.value === 'no' ? 'yes' : 'no'}`;
    case 'lockfile': return `lockfile:${clause.value}`;
    case 'measure': {
      const percent = measureOf(clause.measure)?.percent;
      const value = percent ? `${Math.round(clause.value * 1000) / 10}%` : String(clause.value);
      return `${clause.measure}${clause.operator}${value}`;
    }
  }
}

/** The chip's words: what it selects, in the interface's language rather than the query's. */
export function clauseLabel(clause: Clause): { key: string; value: string } {
  switch (clause.kind) {
    case 'lang': return { key: 'Language', value: clause.value };
    case 'component': return { key: 'Component', value: clause.value };
    case 'path': return { key: 'Path', value: clause.value };
    case 'has': return { key: 'Has', value: clause.value };
    case 'analysed': return { key: 'Ignored', value: clause.value === 'no' ? 'Yes' : 'No' };
    case 'lockfile': return { key: 'Lockfile', value: clause.value === 'yes' ? 'Yes' : 'No' };
    case 'measure': {
      const { label, percent, minutes } = measureOf(clause.measure) ?? { label: clause.measure };
      const value = percent ? `${Math.round(clause.value * 1000) / 10}%` : minutes ? `${clause.value} min` : String(clause.value);
      return { key: label, value: `${clause.operator === '>=' ? '≥' : clause.operator === '<=' ? '≤' : clause.operator} ${value}` };
    }
  }
}

export function sameClause(a: Clause, b: Clause): boolean {
  return clauseText(a) === clauseText(b);
}

/**
 * Whether a file passes the query. Chips of one kind widen the selection (TypeScript or JavaScript), chips of
 * different kinds narrow it (TypeScript in the core component), and every condition must hold.
 */
export function matches(entry: FileEntry, clauses: readonly Clause[], facts: FileFacts, text = ''): boolean {
  const any = (kind: 'lang' | 'component' | 'path', test: (value: string) => boolean) => {
    const values = clauses.flatMap(clause => clause.kind === kind ? [clause.value] : []);
    return values.length === 0 || values.some(test);
  };
  const path = entry.path.toLowerCase();
  if (text && !path.includes(text.toLowerCase())) return false;
  if (!any('lang', value => languageOf(entry.path).toLowerCase() === value.toLowerCase())) return false;
  if (!any('component', value => (facts.components.get(entry.path) ?? []).some(name => name.toLowerCase() === value.toLowerCase()))) return false;
  if (!any('path', value => path.includes(value.toLowerCase()))) return false;
  return clauses.every(clause => {
    if (clause.kind === 'has') return clause.value === 'findings' ? (facts.findings.get(entry.path) ?? 0) > 0 : entry.diagnosticCount > 0;
    if (clause.kind === 'analysed') return isIgnored(entry) === (clause.value === 'no');
    if (clause.kind === 'lockfile') return isLockfile(entry.path) === (clause.value === 'yes');
    if (clause.kind !== 'measure') return true;
    const value = measureOf(clause.measure)?.read(entry) ?? null;
    if (value === null) return false;
    switch (clause.operator) {
      case '>': return value > clause.value;
      case '>=': return value >= clause.value;
      case '<': return value < clause.value;
      case '<=': return value <= clause.value;
      case '=': return value === clause.value;
    }
  });
}

export interface Suggestion {
  readonly group: string;
  readonly label: string;
  readonly detail?: string;
  readonly clause: Clause;
  readonly color?: string;
}

/** What the field offers for the typed text: the facets of this codebase first, then conditions, then the path. */
export function suggest(text: string, files: readonly FileEntry[], facts: FileFacts, chosen: readonly Clause[]): Suggestion[] {
  const query = text.trim().toLowerCase();
  const taken = (clause: Clause) => chosen.some(other => sameClause(other, clause));
  const result: Suggestion[] = [];
  const counts = new Map<string, number>();
  for (const file of files) counts.set(languageOf(file.path), (counts.get(languageOf(file.path)) ?? 0) + 1);
  for (const [language, total] of [...counts].sort((a, b) => b[1] - a[1])) {
    const clause: Clause = { kind: 'lang', value: language };
    if (!taken(clause) && (!query || language.toLowerCase().includes(query) || 'lang'.startsWith(query))) {
      result.push({ group: 'Languages', label: language, detail: quantity(total), clause, color: languageColor(language) });
    }
  }
  const members = new Map<string, number>();
  for (const names of facts.components.values()) for (const name of names) members.set(name, (members.get(name) ?? 0) + 1);
  for (const [name, total] of members) {
    const clause: Clause = { kind: 'component', value: name };
    if (!taken(clause) && (!query || name.toLowerCase().includes(query) || 'component'.startsWith(query))) {
      result.push({ group: 'Components', label: name, detail: quantity(total), clause });
    }
  }
  // Files only counted, never read by a plugin, are one condition away once the text names them.
  const named = (words: readonly string[]) => query.length >= 3
    && words.some(phrase => phrase.startsWith(query) || (phrase.includes(' ') && phrase.includes(query)));
  const unread = files.filter(isIgnored).length;
  const notAnalysed: Clause = { kind: 'analysed', value: 'no' };
  if (unread && !taken(notAnalysed) && named(['ignored files', 'ignored:yes', 'not analysed', 'analysed:no'])) {
    result.push({ group: 'Conditions', label: 'Ignored files', detail: quantity(unread), clause: notAnalysed });
  }
  const lockfiles = files.filter(file => isLockfile(file.path)).length;
  const lockfile: Clause = { kind: 'lockfile', value: 'yes' };
  if (lockfiles && !taken(lockfile) && named(['lockfiles', 'lockfile:yes'])) {
    result.push({ group: 'Conditions', label: lockfilesLabel, detail: quantity(lockfiles), clause: lockfile });
  }
  const typed = query ? parseWord(text.trim()) : null;
  if (typed && (typed.kind === 'measure' || typed.kind === 'has' || typed.kind === 'analysed' || typed.kind === 'lockfile') && !taken(typed)) {
    const { key, value } = clauseLabel(typed);
    result.push({ group: 'Conditions', label: `${key} ${value}`, clause: typed });
  } else {
    // Other plugins' metrics are offered once the typed text names them; the presets stay Repometry's own.
    if (query) for (const [key, { label }] of pluginMeasures) {
      const clause: Clause = { kind: 'measure', measure: key, operator: '>', value: 0 };
      if (!taken(clause) && (key.startsWith(query) || label.toLowerCase().includes(query))) {
        result.push({ group: 'Conditions', label: `${label} above zero`, detail: `${label} > 0`, clause });
      }
    }
    for (const preset of presets) {
      const clause = parseWord(preset.text)!;
      const { key, value } = clauseLabel(clause);
      if (!taken(clause) && (!query || preset.label.toLowerCase().includes(query) || preset.text.startsWith(query) || key.toLowerCase().includes(query))) {
        result.push({ group: 'Conditions', label: preset.label, detail: `${key} ${value}`, clause });
      }
    }
  }
  if (query && !(typed && typed.kind !== 'path')) {
    result.push({ group: 'Path', label: `Path contains “${text.trim()}”`, clause: { kind: 'path', value: text.trim() } });
  }
  return result;
}

function quantity(total: number): string {
  return `${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}`;
}

export interface QueryField {
  readonly element: HTMLElement;
  /** Text typed but not yet made a chip; it filters paths as you type. */
  readonly text: () => string;
  /** Replaces the chips from outside, as when a language is picked on the bar; reports the change as typing does. */
  readonly set: (clauses: readonly Clause[]) => void;
}

/**
 * The field: chips for the chosen clauses, then a text input; the list of suggestions hangs from it in one frame.
 * Backspace in an empty input takes the last chip back into text, so a chip can be edited, not just removed.
 */
export function queryField(clauses: readonly Clause[], options: {
  readonly suggestions: (text: string) => Suggestion[];
  readonly change: (clauses: readonly Clause[], text: string) => void;
}): QueryField {
  let chosen = [...clauses];
  let active = 0;
  let shown: Suggestion[] = [];
  const root = element('div', 'qf');
  const box = element('div', 'qf-box');
  const chips = element('span', 'qf-chips');
  const input = element('input', 'qf-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', 'Filter files');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const list = element('ul', 'qf-options');
  list.id = `qf-options-${Math.random().toString(36).slice(2, 8)}`;
  list.setAttribute('role', 'listbox');
  input.setAttribute('aria-controls', list.id);
  const popover = element('div', 'qf-popover');
  popover.hidden = true;
  const help = element('p', 'qf-help', 'Combine chips: same kind widens, different kinds narrow. Type complexity>10 or coverage<80% for a condition.');
  popover.append(list, help);
  box.append(chips, input);
  root.append(box, popover);

  function placeholder(): void {
    input.placeholder = chosen.length ? 'Add a filter' : 'Filter by language, component, condition or path';
  }

  function renderChips(): void {
    chips.replaceChildren(...chosen.map((clause, index) => {
      const chip = element('span', `qf-chip qf-chip-${clause.kind}`);
      const { key, value } = clauseLabel(clause);
      if (clause.kind === 'lang') {
        const dot = element('span', 'qf-dot');
        dot.style.background = languageColor(clause.value);
        chip.append(dot);
      }
      chip.append(element('span', 'qf-chip-key', key), element('span', 'qf-chip-value', value));
      const remove = element('button', 'qf-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${key} ${value}`);
      remove.addEventListener('click', () => {
        chosen.splice(index, 1);
        commit();
        input.focus();
      });
      chip.append(remove);
      return chip;
    }));
    placeholder();
  }

  function commit(): void {
    renderChips();
    options.change(chosen, input.value.trim());
    if (!popover.hidden) update();
  }

  function update(): void {
    shown = options.suggestions(input.value);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let group = '';
    list.replaceChildren(...shown.flatMap((suggestion, index) => {
      const items: HTMLElement[] = [];
      if (suggestion.group !== group) {
        group = suggestion.group;
        const heading = element('li', 'qf-group', group);
        heading.setAttribute('role', 'presentation');
        items.push(heading);
      }
      const item = element('li', 'qf-option');
      item.id = `${list.id}-${index}`;
      item.setAttribute('role', 'option');
      if (suggestion.color) {
        const dot = element('span', 'qf-dot');
        dot.style.background = suggestion.color;
        item.append(dot);
      }
      item.append(element('span', 'qf-option-label', suggestion.label));
      if (suggestion.detail) item.append(element('span', 'qf-option-detail', suggestion.detail));
      item.addEventListener('mousedown', event => event.preventDefault());
      item.addEventListener('click', () => choose(suggestion));
      item.addEventListener('mousemove', () => { if (active !== index) { active = index; highlight(); } });
      items.push(item);
      return items;
    }));
    highlight();
  }

  function highlight(): void {
    for (const item of list.querySelectorAll('.qf-option')) item.classList.toggle('active', item.id === `${list.id}-${active}`);
    const current = list.querySelector<HTMLElement>(`#${list.id}-${active}`);
    if (current) {
      input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function open(): void {
    if (!popover.hidden) return;
    popover.hidden = false;
    root.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    active = 0;
    update();
    document.addEventListener('pointerdown', outside, true);
  }

  function close(): void {
    if (popover.hidden) return;
    popover.hidden = true;
    root.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  }

  function outside(event: Event): void {
    if (!root.contains(event.target as Node)) close();
  }

  function choose(suggestion: Suggestion): void {
    if (!chosen.some(clause => sameClause(clause, suggestion.clause))) chosen.push(suggestion.clause);
    input.value = '';
    active = 0;
    commit();
  }

  box.addEventListener('pointerdown', event => {
    if (event.target === box || event.target === chips) {
      event.preventDefault();
      input.focus();
    }
  });
  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    open();
    active = 0;
    update();
    options.change(chosen, input.value.trim());
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      if (shown.length) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      highlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const typed = input.value.trim();
      const suggestion = shown[active];
      if (suggestion && !popover.hidden) choose(suggestion);
      else if (typed) choose({ group: '', label: typed, clause: parseWord(typed) ?? { kind: 'path', value: typed } });
    } else if (event.key === 'Escape') {
      if (!popover.hidden) {
        event.preventDefault();
        close();
      }
    } else if (event.key === 'Backspace' && input.value === '' && chosen.length) {
      event.preventDefault();
      input.value = clauseText(chosen.pop()!);
      commit();
    }
  });
  renderChips();
  return {
    element: root,
    text: () => input.value.trim(),
    set(next) {
      chosen = [...next];
      commit();
    },
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
