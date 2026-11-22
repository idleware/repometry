import type { Finding } from '../../json/wire/domain-types.js';
import type { FileMetricsReport } from '../../json/wire/file-metrics-model.js';
import type { InspectionDetails } from '../../json/wire/inspection-details-model.js';
import type { MetricDescriptor } from '../../json/wire/summary-model.js';
import { formatQuery, languageColor, languageOf, matches, parseQuery, queryField, suggest, usePluginMeasures } from './viewer-filter.js';
import type { Clause, FileFacts } from './viewer-filter.js';
import { bandLabels as pluginBandLabels, bandOf, bandScale, catalogIndex, compareValues, entryValue, firstSortAscending, format, rollUp } from './viewer-metric-registry.js';
import { extendCatalog, pluginMetrics, pluginSpec } from './viewer-metrics.js';
import type { PluginMetric } from './viewer-metrics.js';
import { highlightCode, lineSnippet, renderExcerpt, renderSource } from './viewer-source.js';

type View = 'metrics' | 'hotspots' | 'diagnostics' | 'issues';
type Metrics = FileMetricsReport['files'][number];
type Directory = FileMetricsReport['directories'][number];
type BuiltinHotspot = keyof FileMetricsReport['hotspots'];
/** What the code map and the ranking measure: one of Repometry's rankings, or another plugin's metric by its key. */
export type HotspotMetric = BuiltinHotspot | PluginMetric;

interface Navigation {
  readonly directory: string;
  readonly file: string;
  /** The Metrics query and grouping from the URL. */
  readonly query?: string | undefined;
  readonly group?: string | undefined;
  /** A source line to bring into view. */
  readonly line?: number | undefined;
  /** The Issues filters from the URL: finding categories, comma-separated, and a severity. */
  readonly category?: string | undefined;
  readonly level?: string | undefined;
  /** What Hotspots ranks by. */
  readonly rank?: string | undefined;
  /** Source text of a file at this commit; absent where the view cannot load source. */
  readonly source?: ((path: string) => Promise<string | null>) | undefined;
  /** The file's page on its forge, when the export names one. */
  readonly sourcePage?: ((path: string, line?: number) => { readonly href: string; readonly provider: string } | null) | undefined;
  href(view: View, options?: LinkOptions): string;
}

export interface LinkOptions {
  readonly directory?: string;
  readonly file?: string;
  readonly query?: string;
  readonly group?: string;
  readonly line?: number;
  readonly category?: string;
  readonly level?: string;
  readonly rank?: string;
}

/**
 * The finding categories Repometry counts as code smells, mirroring core's quality summary (structure and
 * duplication), so the Overview's smell count links to exactly the findings it counts.
 */
export const codeSmellCategories = ['structure', 'duplication'] as const;
/** The finding categories behind the security level, as the Overview's security column counts them. */
export const securityCategories = ['security', 'dependency', 'secret', 'infrastructure'] as const;

const integer = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const collator = new Intl.Collator(undefined, { numeric: true });
const pageSize = 50;
const hotspotChoices = [
  ['complexity', 'Cyclomatic complexity'],
  ['cognitive', 'Cognitive complexity'],
  ['missedLines', 'Uncovered lines'],
  ['duplication', 'Duplicated lines'],
  ['churn', 'Git churn'],
] as const;
interface Preferences {
  mode: string;
  sort: number;
  ascending: boolean;
  hotspot: HotspotMetric;
  columns: Map<number, boolean>;
  /** Whether the files no plugin read are listed, or folded into one row at the end. */
  unanalysed: boolean;
}
const preferences = new WeakMap<HTMLElement, Preferences>();

/** The inspection's own catalog: its file and folder values are indexed by it, not by the history's. */
let local: { readonly catalog: readonly MetricDescriptor[] | undefined; readonly index: ReadonlyMap<string, number> } = { catalog: undefined, index: new Map() };

function useDetails(details: InspectionDetails): void {
  const catalog = details.metrics.catalog;
  extendCatalog(catalog);
  local = { catalog, index: catalogIndex(catalog) };
  usePluginMeasures(pluginMetrics().filter(spec => spec.descriptor.scope === 'file' && measured(spec.descriptor)).map(spec => [spec.key, {
    label: spec.label, percent: spec.descriptor.unit === 'ratio', minutes: spec.descriptor.unit === 'minutes',
    read: (entry: Metrics) => entryValue(local.index, entry, spec),
  }] as const));
}

/** Whether this inspection ran the metric: a ratio ran where its denominator did. */
function measured(descriptor: MetricDescriptor): boolean {
  return local.index.has(descriptor.ratio?.over ?? descriptor.id);
}

/** Other plugins' metrics as Metrics columns, after Repometry's own, in the order the history lists them. */
function pluginColumns(): MetricColumn[] {
  return pluginMetrics().filter(spec => spec.descriptor.scope === 'file').map(spec => ({
    label: spec.short,
    value: entry => entryValue(local.index, entry, spec),
    display: entry => format(spec, entryValue(local.index, entry, spec)),
    available: () => measured(spec.descriptor),
    defaultVisible: () => spec.column,
    ascending: firstSortAscending(spec),
  }));
}

export function renderFileView(container: HTMLElement, view: View, details: InspectionDetails, navigation: Navigation): void {
  useDetails(details);
  // A small codebase reads best as one flat list; a large one starts from its folders.
  const settings = preferences.get(container) ?? { mode: details.metrics.files.length <= 1000 ? 'list' : 'tree', sort: 0, ascending: true,
    hotspot: 'complexity', columns: new Map(), unanalysed: false };
  preferences.set(container, settings);
  const selectedFile = details.metrics.files.find(file => file.path === navigation.file);
  const requested = selectedFile && view === 'metrics' ? parentPath(selectedFile.path) : navigation.directory;
  const directory = details.metrics.directories.find(entry => entry.path === requested)?.path ?? '';
  switch (view) {
    case 'metrics': container.replaceChildren(selectedFile && navigation.source
      ? fileView(details, navigation, selectedFile, navigation.source)
      : metricsView(details, navigation, settings, directory, selectedFile)); break;
    case 'hotspots': container.replaceChildren(hotspotView(details, navigation, settings, directory)); break;
    case 'issues': container.replaceChildren(issuesView(details, navigation)); break;
    case 'diagnostics': container.replaceChildren(diagnosticsView(details, navigation)); break;
  }
}

interface MetricColumn {
  readonly label: string;
  value(entry: Metrics): string | number | null;
  display(entry: Metrics): string;
  available?(directory?: Directory): boolean;
  defaultVisible?(directory?: Directory): boolean;
  /** The first click sorts this way: worst first. Repometry's own columns open descending. */
  readonly ascending?: boolean;
}

const builtinColumns: readonly [MetricColumn, ...MetricColumn[]] = [
  { label: 'Path', value: entry => entry.path, display: entry => entry.path },
  { label: 'Code lines', value: entry => entry.quality?.codeLines ?? null, display: entry => count(entry.quality?.codeLines),
    available: directory => directory?.quality?.codeLines !== undefined },
  { label: 'Physical lines', value: entry => entry.lines, display: entry => count(entry.lines),
    defaultVisible: directory => directory?.quality?.codeLines === undefined },
  { label: 'Functions', value: entry => entry.functions, display: entry => count(entry.functions), defaultVisible: () => false },
  { label: 'Peak cyclomatic', value: entry => entry.complexity?.maximum ?? null, display: entry => count(entry.complexity?.maximum) },
  { label: 'Cognitive', value: entry => entry.quality?.cognitiveComplexity ?? null, display: entry => count(entry.quality?.cognitiveComplexity),
    available: directory => directory?.quality?.cognitiveComplexity !== undefined },
  { label: 'Line coverage', value: coverageRatio, display: coverageText, available: directory => directory ? coverageRatio(directory) !== null : true },
  { label: 'Duplication', value: duplicationRatio, display: duplicationText,
    available: directory => directory?.quality?.duplication !== undefined },
  { label: 'Remediation', value: entry => entry.quality?.maintainability?.effortMinutes ?? null,
    display: entry => duration(entry.quality?.maintainability?.effortMinutes),
    available: directory => directory?.quality?.maintainability !== undefined },
  { label: 'Git changes', value: entry => entry.quality?.churn ?? null,
    display: entry => count(entry.quality?.churn),
    available: directory => directory?.quality?.churn !== undefined, defaultVisible: () => false },
  { label: 'Diagnostics', value: entry => entry.diagnosticCount, display: entry => count(entry.diagnosticCount), defaultVisible: () => false },
];

type Group = 'folders' | 'files' | 'components';
type RowKind = 'folder' | 'file' | 'component';

function isGroup(value: string | undefined): value is Group {
  return value === 'folders' || value === 'files' || value === 'components';
}

function metricsView(details: InspectionDetails, navigation: Navigation, settings: Preferences, directory: string,
  selectedFile?: Metrics): HTMLElement {
  const view = element('div', 'fx-view');
  const { metrics } = details;
  const columns: readonly [MetricColumn, ...MetricColumn[]] = [...builtinColumns, ...pluginColumns()];
  const scopeFiles = metrics.files.filter(entry => inside(entry.path, directory));
  const scopeTotals = aggregate(directory, scopeFiles);
  const components = details.components ?? [];
  const facts: FileFacts = {
    components: componentIndex(components),
    findings: findingIndex(details.findings ?? []),
  };
  let clauses: readonly Clause[] = parseQuery(navigation.query ?? '');
  let text = '';
  let group: Group = isGroup(navigation.group) ? navigation.group : settings.mode === 'tree' ? 'folders' : 'files';
  // Every link out of the view carries the query and the grouping, so a file opened from a selection keeps it.
  const linkTo = (options: { directory?: string; file?: string } = {}) =>
    navigation.href('metrics', { ...options, query: formatQuery(clauses), group });
  const trail = element('div');
  view.append(trail);

  const split = element('div', 'fx-split');
  const main = element('div', 'fx-main');
  split.append(main, splitter(split));
  view.append(split);

  const field = queryField(clauses, {
    suggestions: typed => suggest(typed, scopeFiles, facts, clauses),
    change: (next, typed) => {
      clauses = next;
      text = typed;
      page = 0;
      remember();
      refresh();
    },
  });
  const grouping = segmented('Group by', [['folders', 'Folders'], ['files', 'Files'], ['components', 'Components']], group, value => {
    group = value as Group;
    settings.mode = group === 'folders' ? 'tree' : 'list';
    page = 0;
    remember();
    refresh();
  });
  const tools = element('div', 'fx-tools fx-metrics-tools');
  const columnsMenu = element('details', 'fx-columns');
  const summary = element('summary', '', 'Columns');
  const toggles = element('div', 'fx-column-toggles');
  columnsMenu.append(summary, toggles);
  dismissible(columnsMenu);
  tools.append(field.element, grouping, columnsMenu);
  const languages = element('div', 'fx-languages');
  const hint = element('p', 'fx-hint');
  hint.hidden = true;

  function isVisible(index: number): boolean {
    return index === 0 || Boolean(toggles.querySelector<HTMLInputElement>(`[value="${index}"]`)?.checked);
  }
  columns.forEach((column, index) => {
    if (index === 0 || column.available?.(scopeTotals) === false) return;
    const label = element('label', 'fx-column-toggle', column.label);
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.value = String(index);
    toggle.checked = settings.columns.get(index) ?? column.defaultVisible?.(scopeTotals) ?? true;
    toggle.addEventListener('change', () => {
      settings.columns.set(index, toggle.checked);
      if (!isVisible(settings.sort)) { settings.sort = 0; settings.ascending = true; }
      page = 0;
      refresh();
    });
    label.prepend(toggle);
    toggles.append(label);
  });
  if (!isVisible(settings.sort)) { settings.sort = 0; settings.ascending = true; }
  const result = element('p', 'fx-note fx-results');
  result.setAttribute('aria-live', 'polite');
  const table = element('table', 'fx-table');
  const header = element('tr');
  const thead = element('thead');
  const body = element('tbody');
  const headers = columns.map(({ label }, index) => {
    const th = element('th', index ? 'numeric' : '');
    th.scope = 'col';
    const sort = element('button', 'fx-sort', label);
    sort.type = 'button';
    sort.addEventListener('click', () => {
      settings.ascending = settings.sort === index ? !settings.ascending : index === 0 || (columns[index]!.ascending ?? false);
      settings.sort = index;
      page = 0;
      refresh();
    });
    th.append(sort);
    header.append(th);
    return th;
  });
  thead.append(header);
  table.append(thead, body);

  const pager = element('div', 'fx-pager');
  const navigationState = navigationButtons('File pages', () => { page--; refresh(); }, () => { page++; refresh(); });
  // The count of what the list holds stands with the page buttons, under the table it counts.
  pager.append(result, navigationState.section);
  const tableWrap = scrollableTable(table, 'File and directory metrics');
  const note = element('p', 'fx-note');
  main.append(tools, languages, hint, tableWrap, pager, note);
  let page = 0;
  let current: HTMLElement | undefined;

  /** The URL follows the query, without a new history entry per keystroke. */
  function remember(): void {
    history.replaceState(history.state, '', navigation.href('metrics', {
      directory, ...(selectedFile ? { file: selectedFile.path } : {}), query: formatQuery(clauses), group }));
  }

  function selected(...except: Clause['kind'][]): Metrics[] {
    const kept = clauses.filter(clause => !except.includes(clause.kind));
    return scopeFiles.filter(entry => matches(entry, kept, facts, text));
  }

  function refresh(): void {
    const files = selected();
    const filtering = clauses.length > 0 || text !== '';
    trail.replaceChildren(breadcrumbs('metrics', { ...navigation, href: (_, options) => linkTo(options) }, directory));
    renderLanguages(selected('lang', 'analysed'));
    const sort = columns[settings.sort] ?? columns[0];
    let rows: { entry: Metrics; kind: RowKind }[];
    hint.hidden = true;
    if (group === 'components') {
      if (components.length === 0) {
        hint.hidden = false;
        hint.replaceChildren('No components are defined for this repository. Group paths into components in ',
          element('code', '', '.repometry/components.json'), ' to compare them here.');
        rows = [];
      } else {
        const chosen = new Set(files.map(entry => entry.path));
        rows = components.map(({ component, paths }) => ({
          entry: aggregate(component.name, paths.flatMap(path => chosen.has(path) ? [byPath.get(path)!] : [])), kind: 'component' as const }))
          .filter(row => !filtering || (row.entry as Directory).files > 0);
        const assigned = new Set(components.flatMap(({ paths }) => paths));
        const rest = files.filter(entry => !assigned.has(entry.path));
        if (rest.length) rows.push({ entry: aggregate('Not in a component', rest), kind: 'component' });
      }
    } else if (group === 'folders' && !filtering) {
      rows = [...metrics.directories.filter(entry => entry.path && parentPath(entry.path) === directory).map(entry => ({ entry, kind: 'folder' as const })),
        ...files.filter(entry => parentPath(entry.path) === directory).map(entry => ({ entry, kind: 'file' as const }))];
    } else if (group === 'folders') {
      // Filtered folders hold only what passes the query, and their totals count only that.
      const below = new Map<string, Metrics[]>();
      const here: Metrics[] = [];
      for (const entry of files) {
        const rest = directory ? entry.path.slice(directory.length + 1) : entry.path;
        const slash = rest.indexOf('/');
        if (slash < 0) here.push(entry);
        else {
          const folder = (directory ? `${directory}/` : '') + rest.slice(0, slash);
          below.set(folder, [...below.get(folder) ?? [], entry]);
        }
      }
      rows = [...[...below].map(([path, entries]) => ({ entry: aggregate(path, entries), kind: 'folder' as const })),
        ...here.map(entry => ({ entry, kind: 'file' as const }))];
    } else rows = files.map(entry => ({ entry, kind: 'file' as const }));
    rows.sort((a, b) => {
      if (settings.sort === 0 && (a.kind === 'file') !== (b.kind === 'file')) return a.kind === 'file' ? 1 : -1;
      return compare(a.entry, b.entry, sort.value, settings.ascending);
    });
    headers.forEach((th, index) => {
      th.hidden = !isVisible(index);
      if (index === settings.sort) th.setAttribute('aria-sort', settings.ascending ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
    headers[0]!.querySelector('button')!.textContent = group === 'components' ? 'Component' : 'Path';
    // The code comes first, whatever the sort: files no plugin read, and folders holding only such files, fold into
    // one row at the end. A query that asks for them, or a list of nothing else, shows them as they are.
    const unreadPaths = unreadFolders(scopeFiles);
    const unread = (row: { entry: Metrics; kind: RowKind }) => row.kind === 'file' ? row.entry.analysed === false
      : row.kind === 'folder' && unreadPaths.has(row.entry.path);
    const folded = clauses.some(clause => clause.kind === 'analysed') ? [] : rows.filter(unread);
    const read = folded.length ? rows.filter(row => !folded.includes(row)) : rows;
    const display: ({ entry: Metrics; kind: RowKind } | { kind: 'unread' })[] = !folded.length || !read.length ? rows
      : [...read, { kind: 'unread' }, ...settings.unanalysed ? folded : []];
    const first = page * pageSize;
    const visible = display.slice(first, first + pageSize);
    const visibleColumns = columns.slice(1).filter((_, index) => isVisible(index + 1));
    body.replaceChildren(...visible.map(row => row.kind === 'unread' ? unreadRow(folded, visibleColumns.length + 1, settings.unanalysed, () => {
      settings.unanalysed = !settings.unanalysed;
      refresh();
    }) : metricsRow(row.entry, row.kind, group, visibleColumns, linkTo, selectedFile?.path,
      row.kind === 'component' && row.entry.path !== 'Not in a component' ? () => {
        group = 'files';
        settings.mode = 'list';
        grouping.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.textContent === 'Files')));
        field.set([...clauses.filter(clause => clause.kind !== 'component'), { kind: 'component', value: row.entry.path }]);
      } : undefined)));
    const noun = group === 'components' ? 'components' : group === 'folders' ? 'entries' : 'files';
    // A filtered file list says how many of the folder's files it kept; other lists name the selection only once.
    const listsFiles = noun === 'files' && rows.length === files.length;
    const of = filtering && !(listsFiles && display.length <= pageSize) ? ` · ${count(files.length)} of ${count(scopeFiles.length)} files selected` : '';
    result.textContent = rows.length === 0 ? (hint.hidden ? 'No files match this selection.' : '')
      : display.length > pageSize ? `${count(first + 1)}–${count(first + visible.length)} of ${count(rows.length)} ${noun}${of}`
        : filtering && listsFiles ? `${count(rows.length)} of ${count(scopeFiles.length)} files`
        : `${count(rows.length)} ${rows.length === 1 ? noun.replace(/s$/, '').replace('entrie', 'entry') : noun}${of}`;
    tableWrap.hidden = rows.length === 0;
    pager.hidden = !result.textContent;
    navigationState.section.hidden = display.length <= pageSize;
    navigationState.update(page, Math.ceil(display.length / pageSize));
    note.hidden = rows.length === 0;
    note.textContent = 'A dash marks an unavailable measurement. Totals include measured files.'
      + (visibleColumns.some(column => column.label === 'Remediation') ? ' Remediation is assigned to each finding’s primary file.' : '');
    const aside = selectedFile ? fileDetails(details, selectedFile, { ...navigation, href: (target, options) => target === 'metrics' ? linkTo(options) : navigation.href(target, options) })
      : directorySummary(aggregate(directory, files), filtering ? `${count(files.length)} of ${count(scopeFiles.length)} files selected` : undefined);
    // Only the side panel is swapped: moving the list column would take focus out of the query field.
    if (current) current.replaceWith(aside);
    else split.append(aside);
    current = aside;
  }

  /** The languages of the selection as one bar; each name toggles its chip. */
  function renderLanguages(files: readonly Metrics[]): void {
    // Where some files are only counted, every share is in physical lines, the one measure all files have, and the
    // files no plugin read stand together at the end in grey: no data, not a language of their own.
    const counted = files.some(entry => entry.analysed === false);
    const weights = new Map<string, number>();
    let unread = 0;
    for (const entry of files) {
      if (entry.analysed === false) {
        unread += entry.lines ?? 0;
        continue;
      }
      const language = languageOf(entry.path);
      weights.set(language, (weights.get(language) ?? 0) + ((counted ? entry.lines : entry.quality?.codeLines ?? entry.lines) ?? 0));
    }
    const total = [...weights.values()].reduce((sum, value) => sum + value, unread);
    const ranked = [...weights].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1]);
    if (unread > 0) ranked.push([notAnalysed, unread]);
    languages.hidden = ranked.length < 2 || total === 0;
    if (languages.hidden) return;
    const picked = new Set(clauses.flatMap(clause => clause.kind === 'lang' ? [clause.value.toLowerCase()] : []));
    const bar = element('div', 'fx-language-bar');
    bar.setAttribute('aria-hidden', 'true');
    const legend = element('div', 'fx-language-legend');
    legend.setAttribute('role', 'group');
    legend.setAttribute('aria-label', counted ? 'Languages by lines' : 'Languages by code lines');
    const unreadPicked = clauses.some(clause => clause.kind === 'analysed' && clause.value === 'no');
    for (const [language, weight] of ranked) {
      const share = weight / total;
      const grey = language === notAnalysed;
      const pressed = grey ? unreadPicked : picked.has(language.toLowerCase());
      const on = grey ? !picked.size || unreadPicked : (picked.size === 0 && !unreadPicked) || picked.has(language.toLowerCase());
      const segment = element('span', on ? 'fx-language-segment' : 'fx-language-segment fx-off');
      segment.style.flexGrow = String(weight);
      segment.style.background = grey ? 'var(--grade-none)' : languageColor(language);
      bar.append(segment);
      const toggle = element('button', grey ? 'fx-language fx-language-unread' : 'fx-language');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(pressed));
      const dot = element('span', 'fx-language-dot');
      dot.style.background = grey ? 'var(--grade-none)' : languageColor(language);
      toggle.append(dot, element('span', 'fx-language-name', language), element('span', 'fx-language-share', percent.format(share)));
      toggle.addEventListener('click', () => {
        const clause: Clause = grey ? { kind: 'analysed', value: 'no' } : { kind: 'lang', value: language };
        field.set(pressed
          ? clauses.filter(other => grey ? other.kind !== 'analysed'
            : !(other.kind === 'lang' && other.value.toLowerCase() === language.toLowerCase()))
          : [...clauses, clause]);
      });
      legend.append(toggle);
    }
    languages.replaceChildren(bar, legend);
  }

  const byPath = new Map(metrics.files.map(entry => [entry.path, entry]));
  refresh();
  return view;
}

/** Totals for any set of files, measured the way folder totals are: sums, the peak, and ratios of sums. */
function aggregate(path: string, files: readonly Metrics[]): Directory {
  const sum = (read: (entry: Metrics) => number | null | undefined) => {
    let total: number | null = null;
    for (const entry of files) {
      const value = read(entry);
      if (value !== null && value !== undefined) total = (total ?? 0) + value;
    }
    return total;
  };
  const peak = files.reduce<number | null>((max, entry) => entry.complexity?.maximum == null ? max : Math.max(max ?? 0, entry.complexity.maximum), null);
  const covered = files.filter(entry => entry.lineCoverage);
  const values = rollUp(local.catalog, files);
  const quality: NonNullable<Metrics['quality']> = {};
  const codeLines = sum(entry => entry.quality?.codeLines);
  if (codeLines !== null) quality.codeLines = codeLines;
  const comments = sum(entry => entry.quality?.commentLines);
  if (comments !== null) quality.commentLines = comments;
  const classes = sum(entry => entry.quality?.classes);
  if (classes !== null) quality.classes = classes;
  const cognitive = sum(entry => entry.quality?.cognitiveComplexity);
  if (cognitive !== null) quality.cognitiveComplexity = cognitive;
  const churn = sum(entry => entry.quality?.churn);
  if (churn !== null) quality.churn = churn;
  if (files.some(entry => entry.quality?.duplication)) {
    quality.duplication = { duplicatedLines: sum(entry => entry.quality?.duplication?.duplicatedLines) ?? 0,
      codeLines: sum(entry => entry.quality?.duplication?.codeLines) ?? 0 };
  }
  if (files.some(entry => entry.quality?.maintainability)) {
    quality.maintainability = { smells: sum(entry => entry.quality?.maintainability?.smells) ?? 0,
      effortMinutes: sum(entry => entry.quality?.maintainability?.effortMinutes) };
  }
  return {
    path, files: files.length, lines: sum(entry => entry.lines), functions: sum(entry => entry.functions),
    complexity: files.some(entry => entry.complexity)
      ? { sum: sum(entry => entry.complexity?.sum) ?? 0, maximum: peak, measuredFunctions: sum(entry => entry.complexity?.measuredFunctions) ?? 0 } : null,
    lineCoverage: covered.length ? { covered: sum(entry => entry.lineCoverage?.covered) ?? 0, total: sum(entry => entry.lineCoverage?.total) ?? 0 } : null,
    diagnosticCount: sum(entry => entry.diagnosticCount) ?? 0,
    sizeMeasuredFiles: files.filter(entry => entry.lines !== null).length, coverageMeasuredFiles: covered.length,
    ...(Object.keys(quality).length ? { quality } : {}),
    ...(values ? { values } : {}),
  };
}

function componentIndex(components: NonNullable<InspectionDetails['components']>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const { component, paths } of components) for (const path of paths) index.set(path, [...index.get(path) ?? [], component.name]);
  return index;
}

function findingIndex(findings: readonly Finding[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const finding of findings) {
    for (const path of new Set(allLocations(finding).map(location => location.path))) index.set(path, (index.get(path) ?? 0) + 1);
  }
  return index;
}

function metricsRow(entry: Metrics, kind: RowKind, group: Group, visibleColumns: readonly MetricColumn[],
  linkTo: (options?: { directory?: string; file?: string }) => string, selectedFile?: string, open?: () => void): HTMLTableRowElement {
  const row = element('tr');
  const name = element('th', 'fx-path-column');
  name.scope = 'row';
  const flat = kind === 'file' && group !== 'folders';
  const anchor = kind === 'component'
    ? open ? Object.assign(element('button', 'fx-entry fx-entry-button', entry.path), { type: 'button' as const, onclick: open })
      : element('span', 'fx-entry fx-entry-muted', entry.path)
    : link(linkTo(kind === 'folder' ? { directory: entry.path } : { directory: parentPath(entry.path), file: entry.path }), flat ? '' : basename(entry.path), 'fx-entry');
  if (flat) {
    // In the flat list the folder is context and the file name is the subject.
    const slash = entry.path.lastIndexOf('/');
    const label = element('span', 'fx-entry-label');
    if (slash >= 0) {
      // A long folder wraps after a slash, never inside a name.
      const folder = element('span', 'fx-entry-folder');
      for (const part of entry.path.slice(0, slash + 1).split(/(?<=\/)/)) folder.append(part, element('wbr'));
      label.append(folder);
    }
    label.append(element('span', 'fx-entry-name', entry.path.slice(slash + 1)));
    anchor.append(label);
  }
  const icon = element('span', kind === 'file' ? 'fx-file-icon' : kind === 'folder' ? 'fx-folder-icon' : 'fx-component-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (kind === 'file') icon.style.color = languageColor(languageOf(entry.path));
  anchor.prepend(icon);
  if (kind !== 'component') anchor.setAttribute('title', entry.path);
  if (entry.path === selectedFile) {
    anchor.setAttribute('aria-current', 'true');
    row.dataset.selected = '';
  }
  name.append(anchor);
  if (kind !== 'file' && 'files' in entry) name.append(element('span', 'fx-entry-count', count((entry as Directory).files)));
  row.append(name, ...visibleColumns.map(column => {
    const cell = element('td', 'numeric', column.display(entry));
    if (column.value(entry) === 0) cell.classList.add('fx-zero');
    if (column.label === 'Duplication') cell.title = duplicationContext(entry) ?? '';
    return cell;
  }));
  return row;
}

/** The name the language bar gives the files no plugin read. */
const notAnalysed = 'Not analysed';

/** The folders all of whose files are only counted, found in one pass over the files. */
export function unreadFolders(files: readonly Pick<Metrics, 'path' | 'analysed'>[]): Set<string> {
  const read = new Map<string, boolean>();
  for (const file of files) {
    const analysed = file.analysed !== false;
    for (let slash = file.path.lastIndexOf('/'); slash > 0; slash = file.path.lastIndexOf('/', slash - 1)) {
      const folder = file.path.slice(0, slash);
      read.set(folder, (read.get(folder) ?? false) || analysed);
    }
  }
  return new Set([...read].filter(([, analysed]) => !analysed).map(([folder]) => folder));
}

/** The fold at the end of the list: how many entries no plugin read, opening and closing in place. */
function unreadRow(entries: readonly { entry: Metrics; kind: RowKind }[], span: number, expanded: boolean, toggle: () => void): HTMLTableRowElement {
  const files = entries.filter(row => row.kind === 'file').length;
  const folders = entries.length - files;
  const parts = [files ? `${count(files)} ${files === 1 ? 'file' : 'files'}` : '', folders ? `${count(folders)} ${folders === 1 ? 'folder' : 'folders'}` : '']
    .filter(Boolean);
  const row = element('tr', 'fx-unread');
  const cell = element('td');
  cell.colSpan = span;
  const button = element('button', 'fx-unread-toggle', `${parts.join(' and ')} not analysed`);
  button.type = 'button';
  button.setAttribute('aria-expanded', String(expanded));
  button.addEventListener('click', toggle);
  cell.append(button);
  row.append(cell);
  return row;
}

function directorySummary(entry: Directory, selection?: string): HTMLElement {
  const panel = element('aside', 'fx-aside');
  panel.setAttribute('aria-label', selection ? 'Selection totals' : 'Folder totals');
  const heading = element('div', 'fx-aside-heading');
  heading.append(element('h2', '', selection ? 'Selection' : entry.path ? basename(entry.path) : 'All files'));
  if (selection) heading.append(element('p', 'fx-aside-path fx-aside-selection', selection));
  else if (entry.path.includes('/')) heading.append(element('p', 'fx-aside-path', parentPath(entry.path) + '/'));
  const facts = element('dl', 'fx-kv');
  // A measurement the inspection did not take leaves no row behind.
  const quality = entry.quality;
  facts.append(...[
    fact('Files', count(entry.files)),
    quality?.codeLines !== undefined ? fact('Code lines', count(quality.codeLines)) : fact('Physical lines', count(entry.lines)),
    entry.functions === null ? null : fact('Functions', count(entry.functions)),
    fact('Peak cyclomatic', count(entry.complexity?.maximum)),
    quality?.cognitiveComplexity === undefined ? null : fact('Cognitive', count(quality.cognitiveComplexity)),
    quality?.duplication === undefined ? null : fact('Duplication', duplicationText(entry)),
    quality?.maintainability === undefined ? null : fact('Remediation', duration(quality.maintainability.effortMinutes)),
    coverageRatio(entry) === null ? null : fact('Line coverage', coverageText(entry)),
    // Other plugins' totals follow Repometry's own, where this inspection ran them and they roll up.
    ...pluginMetrics().filter(spec => spec.descriptor.scope === 'file' && spec.descriptor.aggregate !== 'none' && measured(spec.descriptor))
      .map(spec => fact(spec.short, format(spec, entryValue(local.index, entry, spec)))),
  ].filter(item => item !== null));
  panel.append(heading, facts);
  return panel;
}

interface SourceHooks {
  /** Brings a line of the open source into view. */
  readonly reveal?: (line: number) => void;
  /** The loaded source text, which names anonymous functions by their first line. */
  readonly text?: string;
}

function fileDetails(details: InspectionDetails, entry: Metrics, navigation: Navigation, hooks: SourceHooks = {}): HTMLElement {
  const panel = element('aside', 'fx-aside fx-file');
  panel.setAttribute('aria-label', 'File details');
  const heading = element('div', 'fx-aside-heading');
  const title = element('h2', '', basename(entry.path));
  const close = link(navigation.href('metrics', { directory: parentPath(entry.path) }), '', 'fx-close');
  close.setAttribute('aria-label', 'Close file details');
  close.title = 'Close file details';
  heading.append(title, close);
  if (entry.path.includes('/')) heading.append(element('p', 'fx-aside-path', parentPath(entry.path) + '/'));
  const facts = element('dl', 'fx-kv');
  const quality = entry.quality;
  if (quality?.codeLines !== undefined) facts.append(fact('Code lines', count(quality.codeLines)));
  facts.append(fact('Physical lines', count(entry.lines)));
  if (quality?.commentLines !== undefined) facts.append(fact('Comment lines', count(quality.commentLines)));
  facts.append(fact('Functions', count(entry.functions)));
  if (quality?.classes) facts.append(fact('Classes', count(quality.classes)));
  facts.append(fact('Peak cyclomatic', count(entry.complexity?.maximum)));
  if (quality?.cognitiveComplexity !== undefined) facts.append(fact('Cognitive', count(quality.cognitiveComplexity)));
  facts.append(fact('Line coverage', coverageText(entry), coverageContext(entry)));
  if (quality?.duplication) facts.append(fact('Duplication', duplicationText(entry), duplicationContext(entry)));
  if (quality?.maintainability) facts.append(fact('Remediation', duration(quality.maintainability.effortMinutes)));
  if (quality?.churn !== undefined) {
    const window = details.metrics.churnWindow;
    facts.append(fact('Git changes', count(quality.churn), window ? `${count(window.lookbackDays)}-day window` : undefined));
  }
  panel.append(heading, facts);

  const findings = details.findings?.filter(item => atPath(item, entry.path));
  const links = element('p', 'fx-aside-links');
  if (findings?.length) links.append(link(navigation.href('issues', { file: entry.path }), quantity(findings.length, 'finding'), 'fx-inline-link'));
  if (entry.diagnosticCount) links.append(link(navigation.href('diagnostics', { file: entry.path }), quantity(entry.diagnosticCount, 'diagnostic'), 'fx-inline-link'));
  if (links.childElementCount) panel.append(links);

  // The side column has room for the functions, most complex first; a long file folds the rest away.
  const functions = details.functions.filter(record => record.path === entry.path)
    .sort((a, b) => b.complexity - a.complexity);
  if (functions.length) {
    const section = element('section', 'fx-aside-section');
    const list = (records: typeof functions) => hooks.reveal ? sourceFunctionList(records, hooks.reveal, hooks.text) : functionList(records);
    section.append(element('h3', '', 'Functions by complexity'), list(functions.slice(0, 10)));
    if (functions.length > 10) {
      const rest = element('details', 'fx-functions');
      rest.append(element('summary', '', `${functions.length - 10} more`), list(functions.slice(10)));
      section.append(rest);
    }
    panel.append(section);
  }
  return panel;
}

/** Functions as buttons that bring their first line into view; an anonymous one is named by that line's code. */
function sourceFunctionList(functions: InspectionDetails['functions'], reveal: (line: number) => void, text?: string): HTMLOListElement {
  const list = element('ol', 'fx-function-list fx-function-jumps');
  list.append(...functions.map(record => {
    const row = element('li');
    const snippet = record.name === '(anonymous)' && text && record.line !== null ? lineSnippet(text, record.line) : null;
    const button = element('button', 'fx-function-jump');
    button.type = 'button';
    button.disabled = record.line === null;
    const name = element(snippet ? 'code' : 'span', 'fx-function-name');
    if (snippet) name.append(...highlightCode(record.path, snippet));
    else name.textContent = record.name;
    button.append(name);
    if (record.line !== null) button.append(element('span', 'fx-function-line', `${record.line}`));
    button.addEventListener('click', () => { if (record.line !== null) reveal(record.line); });
    row.append(button, element('strong', 'fx-function-score', count(record.complexity)));
    return row;
  }));
  return list;
}

/**
 * An open file: its source with the inspection laid on its lines, and its figures and functions beside it. The
 * functions lead into the code, and a chosen line goes into the URL so the place can be shared.
 */
function fileView(details: InspectionDetails, navigation: Navigation, file: Metrics, load: (path: string) => Promise<string | null>): HTMLElement {
  const view = element('div', 'fx-view');
  const keep = { query: navigation.query ?? '', group: navigation.group ?? '' };
  const nav: Navigation = { ...navigation,
    href: (target, options) => target === 'metrics' ? navigation.href('metrics', { ...keep, ...options }) : navigation.href(target, options) };
  view.append(breadcrumbs('metrics', nav, parentPath(file.path)));
  const split = element('div', 'fx-split fx-split-source');
  const main = element('section', 'fx-source panel');
  main.setAttribute('aria-label', 'Source');
  const head = element('div', 'fx-source-head');
  const language = languageOf(file.path);
  const dot = element('span', 'fx-language-dot');
  dot.style.background = languageColor(language);
  // The folder is in the breadcrumbs right above; the head names the file alone, with its full path on hover.
  const name = element('code', 'fx-source-path', basename(file.path));
  name.title = file.path;
  head.append(name, element('span', 'fx-source-meta'));
  head.lastElementChild!.append(dot, `${language} · ${count(file.lines)} lines`);
  // The forge's page for the file, at the chosen line, whether or not the text opens here.
  const page = navigation.sourcePage?.(file.path, navigation.line);
  const forge = page ? link(page.href, `View on ${page.provider}`, 'fx-source-forge') : null;
  if (forge) {
    forge.target = '_blank';
    forge.rel = 'noopener noreferrer';
    head.lastElementChild!.append(' · ', forge);
  }
  const body = element('div', 'fx-source-body');
  body.append(element('p', 'fx-note fx-source-wait', 'Loading source…'));
  main.append(head, body);
  let aside = fileDetails(details, file, nav);
  split.append(main, splitter(split), aside);
  view.append(split);

  const functions = details.functions.filter(record => record.path === file.path);
  const notes = (details.findings ?? []).flatMap(finding => {
    const line = finding.path === file.path ? finding.line : finding.related?.find(location => location.path === file.path)?.line;
    return line ? [{ line, level: finding.level, title: finding.rule, message: finding.message }] : [];
  });
  void load(file.path).then(text => {
    if (text === null) {
      // No locator, a private repository, a commit never pushed: one quiet state, and the forge's page when there is one.
      body.replaceChildren(element('p', 'fx-source-missing', 'Source not available'));
      return;
    }
    const choose = (line: number) => {
      history.replaceState(history.state, '', nav.href('metrics', { directory: parentPath(file.path), file: file.path, line }));
      const moved = navigation.sourcePage?.(file.path, line);
      if (forge && moved) forge.href = moved.href;
    };
    const reveal = renderSource(body, text, {
      path: file.path,
      functions: functions.flatMap(record => record.line === null ? [] : [{ line: record.line, complexity: record.complexity, name: record.name }]),
      notes, line: navigation.line, choose,
    });
    const next = fileDetails(details, file, nav, { text, reveal: line => { reveal(line); choose(line); } });
    aside.replaceWith(next);
    aside = next;
  });
  return view;
}

type MapShape = 'rings' | 'tiles';

interface SunburstOptions {
  readonly metric: HotspotMetric;
  readonly directory?: string;
  readonly compact?: boolean;
  /** Rings (a sunburst) or tiles (a treemap); the last choice is remembered for this viewer. */
  readonly shape?: MapShape;
  /** Offered beside the map's title, where the page lets the viewer switch shapes. */
  readonly reshape?: (shape: MapShape) => void;
  /** More controls for the map's title row, such as what it is coloured by. */
  readonly controls?: HTMLElement;
  /** Sizes only, in grey: the map stands for an area with no measurement of its own, as security without a scanner. */
  readonly muted?: boolean;
  /**
   * Security: each file's worst finding level, 0 none to 4 critical, coloured in the grade steps of the security mark.
   * A folder takes the worst level inside it. Files missing from the map have no findings.
   */
  readonly levels?: ReadonlyMap<string, number>;
  href(view: 'hotspots' | 'metrics', options?: { directory?: string; file?: string }): string;
}

interface Branch {
  readonly entry: Metrics;
  readonly folder: boolean;
  readonly area: number;
  readonly score: number;
}

const maxRanked = 10;
const chartCenter = 200;
const innerRadius = 47;
const outerRadius = 196;
const fullCircle = 2 * Math.PI;
const startAngle = -Math.PI / 2;

function hotspotView(details: InspectionDetails, navigation: Navigation, settings: Preferences, directory: string): HTMLElement {
  const view = element('div', 'fx-view');
  // The window is part of what churn means, so it is in the metric's name rather than in a sentence about it.
  const days = details.metrics.churnWindow?.lookbackDays;
  // Repometry's rankings, then every other plugin's metric this inspection ran that has a worse end to rank by.
  const choices: (readonly [HotspotMetric, string])[] = [
    ...hotspotChoices.map(([value, name]) => [value, value === 'churn' && days ? `Changes in ${count(days)} days` : name] as const),
    ...pluginMetrics().filter(spec => spec.hotspot && measured(spec.descriptor)).map(spec => [spec.key as PluginMetric, spec.label] as const),
  ];
  const linked = choices.find(([value]) => value === navigation.rank)?.[0];
  if (linked) settings.hotspot = linked;
  if (!choices.some(([value]) => value === settings.hotspot)) settings.hotspot = 'complexity';
  const selector = choice('Rank by', choices, settings.hotspot);
  selector.label.classList.add('fx-field-bare');
  const tools = element('div', 'fx-tools fx-hotspot-tools');
  tools.append(breadcrumbs('hotspots', navigation, directory));
  const content = element('div', 'fx-hotspot-content');
  const provenance = element('p', 'fx-note fx-churn-provenance');
  view.append(tools, provenance, content);
  selector.select.addEventListener('change', () => {
    settings.hotspot = choices.find(([value]) => value === selector.select.value)?.[0] ?? 'complexity';
    history.replaceState(history.state, '', navigation.href('hotspots', { directory, rank: settings.hotspot }));
    render();
  });

  const files = details.metrics.files.filter(entry => inside(entry.path, directory));
  const byPath = new Map(files.map(entry => [entry.path, entry]));

  function render(): void {
    const metric = settings.hotspot;
    const caveat = metric === 'churn' ? churnCaveat(details.metrics.churnWindow) : '';
    provenance.hidden = !caveat;
    provenance.textContent = caveat;
    const plugin = pluginSpec(metric);
    const ranked = plugin ? pluginRanking(files, plugin) : (details.metrics.hotspots[metric as BuiltinHotspot] ?? []).flatMap(path => {
      const entry = byPath.get(path);
      return entry ? [entry] : [];
    });
    const hasMeasures = files.some(entry => hotspotScore(entry, metric) !== null);
    const mapSection = renderSunburst(details, { metric, directory, href: navigation.href, reshape: () => render(), controls: selector.label });
    const ranking = rankFiles(ranked, metric, navigation, hasMeasures, bandLimits(details, metric));
    content.replaceChildren(mapSection, ranking);
  }
  // The ranking is the page's side column: its heading stands on the page title's baseline, as a sidebar's does.
  liftToTitle(content, ':scope > .fx-rank h2');
  render();
  return view;
}

export function renderSunburst(details: InspectionDetails, options: SunburstOptions): HTMLElement {
  const { metrics } = details;
  const { metric, directory = '', compact = false, href } = options;
  const limits = bandLimits(details, metric);
  const shape = options.shape ?? mapShape();
  const panel = element('section', compact ? 'fx-sunburst fx-sunburst-compact' : 'panel fx-sunburst');
  panel.dataset.shape = shape;
  const selected = metrics.directories.find(entry => entry.path === directory);
  const useCodeLines = selected?.quality?.codeLines !== undefined;
  // The compact map has no title of its own: the switch alone heads it.
  const heading = element('div', 'fx-map-heading');
  // The view kind heads the map, at the left; what it is coloured by sits at the right. A title would only repeat
  // what the switch and the map already say, so the panel is named for screen readers alone.
  if (!compact) panel.setAttribute('aria-label', 'Code map');
  if (options.reshape) {
    const reshape = options.reshape;
    heading.append(segmented('Map shape', [['rings', 'Sunburst'], ['tiles', 'Treemap']], shape, value => {
      rememberMapShape(value as MapShape);
      reshape(value as MapShape);
    }));
  }
  if (options.controls) heading.append(options.controls);
  if (heading.childElementCount) panel.append(heading);

  const byParent = new Map<string, Branch[]>();
  const levels = options.levels && spreadLevels(options.levels);
  let measured = levels !== undefined;
  function add(entry: Metrics, folder: boolean): void {
    const area = useCodeLines ? entry.quality?.codeLines : entry.lines;
    if (!area || !inside(entry.path, directory)) return;
    measured ||= hotspotScore(entry, metric) !== null;
    const parent = parentPath(entry.path);
    // Nothing measured is nothing to count: a file without functions has no complexity, not an unknown one.
    const score = levels ? levels.get(entry.path) ?? 0 : hotspotScore(entry, metric) ?? 0;
    const branch = { entry, folder, area, score };
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(branch);
    else byParent.set(parent, [branch]);
  }
  for (const folder of metrics.directories) {
    if (folder.path) add(folder, true);
  }
  for (const file of metrics.files) add(file, false);

  const root = byParent.get(directory);
  if (!root || root.length === 0) {
    panel.append(element('p', 'fx-note', 'No measured lines to show for this folder.'));
    return panel;
  }

  const units = useCodeLines ? 'code lines' : 'physical lines';
  let depth = 1;
  let highest = 1;
  const originalDepth = directory ? directory.split('/').length : 0;
  for (const group of byParent.values()) {
    group.sort((a, b) => collator.compare(a.entry.path, b.entry.path));
    for (const entry of group) {
      highest = Math.max(highest, entry.score);
      depth = Math.max(depth, entry.entry.path.split('/').length - originalDepth);
    }
  }
  const chartDepth = Math.min(depth, compact ? 4 : 5);
  const ring = (outerRadius - innerRadius) / chartDepth;
  const plugin = pluginSpec(metric);
  const heat = plugin ? bandScale(plugin) === 'heat' : metric !== 'churn';
  // Grey marks no data: a metric this inspection did not measure at all (no coverage report) is not a map of zeros.
  const grey = options.muted === true || !measured;
  panel.dataset.palette = levels ? 'grade' : grey ? 'none' : heat ? 'heat' : 'neutral';
  // A file no plugin read, or a folder of nothing else, has no measure: grey. Scanners read every file, so the
  // security map colours them all.
  const unread = unreadFolders(metrics.files);
  const shadeOf = (branch: Branch): number | 'none' => levels ? branch.score
    : branch.entry.analysed === false || unread.has(branch.entry.path) ? 'none' : band(branch.entry, metric, branch.score, highest, limits);
  const reading = (branch: Branch) => levels ? securityLevels[branch.score]! : `${count(branch.score)} ${scoreLabel(metric)}`;
  // What the map encodes is said to assistive technology; on screen the legend's scale carries it.
  const description = `${shape === 'tiles' ? 'Tile' : 'Wedge'} size shows ${units}. ${levels ? 'Colour shows the worst security finding.' : meaningOf(metric)}`;
  // The scale runs the panel's width under the title row: the key to the whole map.
  if (!compact) panel.append(grey ? element('p', 'fx-note', 'Nothing measured for this map, so it shows sizes only.') : levels ? levelLegend() : sunburstLegend(metric, limits));

  const canvas = svgElement('svg');
  canvas.classList.add('fx-sunburst-chart');
  const width = shape === 'tiles' ? compact ? 400 : 640 : 400;
  const height = shape === 'tiles' ? compact ? 320 : 420 : 400;
  canvas.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (shape === 'tiles') canvas.classList.add('fx-treemap');
  canvas.setAttribute('role', 'group');
  canvas.setAttribute('aria-label', `Code map of ${directory || 'the repository root'}. ${description}`);
  // Values appear on hover or focus only, so the map does not repeat the ranking beside it.
  // The readout holds its room and fills on hover or focus; the map needs no sentence telling to point at it.
  const summary = element('p', 'fx-map-summary fx-map-hint fx-map-hint-quiet');
  let sectors = 0;
  let smallWedges = false;
  // One outline drawn above every wedge, so neighbours never paint over it.
  const outline = svgElement('path');
  outline.classList.add('fx-wedge-outline');
  outline.setAttribute('aria-hidden', 'true');
  function inspect(branch: Branch, tile: SVGAElement): void {
    // The pointed wedge keeps its colour together with its parents and its contents; the rest of the map fades.
    const own = branch.entry.path;
    canvas.setAttribute('data-inspecting', '');
    for (const wedge of canvas.querySelectorAll<SVGAElement>('.fx-wedge')) {
      const other = wedge.dataset.path!;
      wedge.toggleAttribute('data-related', other === own || own.startsWith(`${other}/`) || other.startsWith(`${own}/`));
    }
    outline.setAttribute('d', tile.querySelector('path')!.getAttribute('d')!);
    canvas.append(outline);
    summary.classList.remove('fx-map-hint');
    const path = element('code', 'fx-path', branch.entry.path);
    const score = reading(branch);
    const additional = metric === 'missedLines' ? ` · ${coverageText(branch.entry)} covered`
      : metric === 'duplication' ? ` · ${duplicationText(branch.entry)} duplicated` : '';
    summary.replaceChildren(path, element('strong', '', score + additional));
  }
  function draw(children: readonly Branch[], first: number, last: number, level: number): void {
    if (level >= chartDepth) return;
    const total = children.reduce((sum, branch) => sum + branch.area, 0);
    const scale = (last - first) / total;
    let start = first;
    for (const branch of children) {
      const end = start + branch.area * scale;
      if (end - start >= 0.018 && sectors < 144) {
        sectors++;
        const tile = svgElement('a');
        tile.classList.add('fx-wedge');
        tile.setAttribute('href', branch.folder ? href('hotspots', { directory: branch.entry.path })
          : href('metrics', { directory: parentPath(branch.entry.path), file: branch.entry.path }));
        const measurement = reading(branch);
        const label = `${branch.entry.path} · ${count(branch.area)} ${units} · ${measurement}`;
        tile.setAttribute('aria-label', label);
        tile.dataset.path = branch.entry.path;
        const path = svgElement('path');
        const radius = innerRadius + level * ring;
        path.setAttribute('d', sectorPath(radius, radius + ring, start, end));
        path.setAttribute('data-band', String(shadeOf(branch)));
        tile.append(path);
        tile.addEventListener('focus', () => inspect(branch, tile));
        tile.addEventListener('pointerenter', () => inspect(branch, tile));
        canvas.append(tile);
        draw(byParent.get(branch.entry.path) ?? [], start, end, level + 1);
      } else smallWedges = true;
      start = end;
    }
  }

  /** The same tree as tiles: folders frame their contents under a name strip, files fill the space by size. */
  function tiles(children: readonly Branch[], x: number, y: number, w: number, h: number, level: number): void {
    for (const { branch, box } of squarify(children, x, y, w, h)) {
      if (box.w < 2 || box.h < 2 || sectors >= 600) {
        smallWedges = true;
        continue;
      }
      sectors++;
      const tile = svgElement('a');
      tile.classList.add('fx-wedge');
      if (branch.folder) tile.classList.add('fx-tile-folder');
      tile.setAttribute('href', branch.folder ? href('hotspots', { directory: branch.entry.path })
        : href('metrics', { directory: parentPath(branch.entry.path), file: branch.entry.path }));
      const measurement = reading(branch);
      tile.setAttribute('aria-label', `${branch.entry.path} · ${count(branch.area)} ${units} · ${measurement}`);
      tile.dataset.path = branch.entry.path;
      const path = svgElement('path');
      path.setAttribute('d', `M${box.x.toFixed(1)},${box.y.toFixed(1)}h${box.w.toFixed(1)}v${box.h.toFixed(1)}h${(-box.w).toFixed(1)}z`);
      const shade = shadeOf(branch);
      path.setAttribute('data-band', String(shade));
      tile.append(path);
      // A chain of folders that each hold one folder is one frame: src/main/ts/ rather than three nested ones.
      let inner = byParent.get(branch.entry.path) ?? [];
      let name = basename(branch.entry.path);
      while (inner.length === 1 && inner[0]!.folder) {
        name += `/${basename(inner[0]!.entry.path)}`;
        inner = byParent.get(inner[0]!.entry.path) ?? [];
      }
      const open = branch.folder && inner.length > 0 && level + 1 < chartDepth + 1 && box.w > 28 && box.h > 28;
      const strip = open && box.w > 64 && box.h > 44 ? 15 : open ? 3 : 0;
      if ((!branch.folder || !open || strip > 3) && box.w > (branch.folder ? 64 : 44) && box.h > (open ? 0 : 17)) {
        const label = svgElement('text');
        label.classList.add('fx-tile-label');
        if (shade !== 'none' && shade >= 3) label.classList.add('fx-tile-label-light');
        label.setAttribute('x', (box.x + 4).toFixed(1));
        label.setAttribute('y', (box.y + 11.5).toFixed(1));
        label.textContent = fit(name + (branch.folder ? '/' : ''), box.w - 8);
        tile.append(label);
      }
      tile.addEventListener('focus', () => inspect(branch, tile));
      tile.addEventListener('pointerenter', () => inspect(branch, tile));
      canvas.append(tile);
      if (open) tiles(inner, box.x + 3, box.y + strip, box.w - 6, box.h - strip - 3, level + 1);
    }
  }

  if (shape === 'tiles') tiles(root, 0, 0, width, height, 0);
  else draw(root, startAngle, startAngle + fullCircle, 0);
  const hint = summary.textContent;
  const reset = () => {
    canvas.removeAttribute('data-inspecting');
    for (const wedge of canvas.querySelectorAll('.fx-wedge[data-related]')) wedge.removeAttribute('data-related');
    outline.remove();
    summary.classList.add('fx-map-hint');
    summary.textContent = hint;
  };
  canvas.addEventListener('pointerleave', reset);
  canvas.addEventListener('focusout', event => {
    if (!canvas.contains(event.relatedTarget as Node | null)) reset();
  });
  const center = svgElement('g');
  center.setAttribute('aria-hidden', 'true');
  const total = root.reduce((sum, branch) => sum + branch.area, 0);
  const value = svgElement('text');
  value.setAttribute('x', String(chartCenter));
  value.setAttribute('y', String(chartCenter + 1));
  value.classList.add('fx-sunburst-value');
  value.textContent = count(total);
  const label = svgElement('text');
  label.setAttribute('x', String(chartCenter));
  label.setAttribute('y', String(chartCenter + 21));
  label.classList.add('fx-sunburst-unit');
  label.textContent = units;
  center.append(value, label);
  // The compact map sits beside the scope line, which already states the total; tiles have no centre to hold it.
  if (!compact && shape === 'rings') canvas.append(center);
  panel.append(canvas, summary);
  return panel;
}

/**
 * Squarified treemap layout: rows of tiles kept as close to square as the areas allow, largest first, so sizes stay
 * comparable at a glance.
 */
function squarify(children: readonly Branch[], x: number, y: number, w: number, h: number): { branch: Branch; box: { x: number; y: number; w: number; h: number } }[] {
  const items = [...children].sort((a, b) => b.area - a.area);
  const total = items.reduce((sum, item) => sum + item.area, 0);
  const placed: { branch: Branch; box: { x: number; y: number; w: number; h: number } }[] = [];
  if (total <= 0 || w <= 0 || h <= 0) return placed;
  const scale = (w * h) / total;
  let box = { x, y, w, h };
  let row: Branch[] = [];
  const worst = (line: readonly Branch[], side: number) => {
    const areas = line.map(item => item.area * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    return Math.max(...areas.map(area => Math.max((side * side * area) / (sum * sum), (sum * sum) / (side * side * area))));
  };
  const lay = (line: readonly Branch[]) => {
    const sum = line.reduce((acc, item) => acc + item.area * scale, 0);
    const vertical = box.w >= box.h;
    const thickness = sum / (vertical ? box.h : box.w);
    let offset = 0;
    for (const item of line) {
      const length = (item.area * scale) / thickness;
      placed.push({ branch: item, box: vertical
        ? { x: box.x, y: box.y + offset, w: thickness, h: length }
        : { x: box.x + offset, y: box.y, w: length, h: thickness } });
      offset += length;
    }
    box = vertical ? { x: box.x + thickness, y: box.y, w: box.w - thickness, h: box.h }
      : { x: box.x, y: box.y + thickness, w: box.w, h: box.h - thickness };
  };
  for (const item of items) {
    const side = Math.min(box.w, box.h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else {
      lay(row);
      row = [item];
    }
  }
  if (row.length) lay(row);
  return placed;
}

/** A label cut to the room it has, at about six pixels a character. */
function fit(text: string, room: number): string {
  const chars = Math.floor(room / 6.2);
  return text.length <= chars ? text : chars > 2 ? `${text.slice(0, chars - 1)}…` : '';
}

/**
 * The handle between a list and its side panel: a line that shows on hover and drags the panel wider or narrower.
 * Arrow keys move it too, a double click restores the default, and the width is remembered for this viewer.
 */
export function splitter(split: HTMLElement): HTMLElement {
  const handle = element('div', 'fx-splitter');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the side panel');
  handle.title = 'Drag to resize; double-click to reset';
  const key = 'repometry.aside';
  const limits = () => ({ low: 224, high: Math.max(224, split.clientWidth * .55) });
  const apply = (width: number | null) => {
    if (width === null) split.style.removeProperty('--aside');
    else {
      const { low, high } = limits();
      const clamped = Math.round(Math.min(high, Math.max(low, width)));
      split.style.setProperty('--aside', `${clamped}px`);
      handle.setAttribute('aria-valuenow', String(clamped));
    }
  };
  const save = (width: number | null) => {
    try {
      if (width === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(width)));
    } catch {
      // Without storage the width lasts for this page only.
    }
  };
  const current = () => split.lastElementChild instanceof HTMLElement && split.lastElementChild !== handle
    ? split.lastElementChild.getBoundingClientRect().width : 320;
  try {
    const stored = Number(localStorage.getItem(key));
    if (stored > 0) requestAnimationFrame(() => apply(stored));
  } catch {
    // Storage may be blocked; the default width stands.
  }
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    split.classList.add('fx-resizing');
    const right = split.getBoundingClientRect().right;
    const move = (next: PointerEvent) => apply(right - next.clientX - handle.offsetWidth / 2);
    const stop = () => {
      split.classList.remove('fx-resizing');
      save(current());
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    apply(current() + (event.key === 'ArrowLeft' ? 24 : -24));
    save(current());
  });
  handle.addEventListener('dblclick', () => { apply(null); save(null); });
  liftToTitle(split, ':scope > .fx-aside h2');
  return handle;
}

/**
 * Raises a side column so its heading stands on the page title's baseline: the list and its summary read as one
 * row of headings. What sits between the title and the panel (a folder path, a toolbar) varies, so the distance is
 * measured, and measured again whenever the page above the panel changes height. One column on a narrow screen: no lift.
 */
function liftToTitle(split: HTMLElement, headingSelector: string): void {
  const baseline = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    // The text box ends below the baseline by the descent, about a fifth of its height.
    return box.bottom - box.height * .2;
  };
  const measure = () => {
    const title = split.closest('section')?.querySelector(':scope > h2');
    const heading = split.querySelector(headingSelector);
    const columns = getComputedStyle(split).gridTemplateColumns.split(' ').length;
    if (!split.isConnected || !title || !heading || columns < 2) {
      split.style.removeProperty('--lift');
      return;
    }
    const current = parseFloat(split.style.getPropertyValue('--lift')) || 0;
    const next = Math.max(0, Math.round(current + baseline(heading) - baseline(title)));
    if (next !== current) split.style.setProperty('--lift', `${next}px`);
  };
  const observer = new ResizeObserver(() => {
    if (!split.isConnected) { observer.disconnect(); return; }
    measure();
  });
  requestAnimationFrame(() => {
    measure();
    // The page section, not the view: a view may be laid out through display: contents and never resize itself.
    const page = split.closest('section') ?? split.parentElement;
    if (page) observer.observe(page);
  });
}

/**
 * The compact map's stand-in while the inspection loads: the same frame, switch and canvas size in a flat tone, so the
 * column keeps its shape and the map fades in where it will stand.
 */
export function mapStub(): HTMLElement {
  const shape = mapShape();
  const panel = element('section', 'fx-sunburst fx-sunburst-compact fx-map-stub');
  panel.dataset.shape = shape;
  panel.setAttribute('aria-busy', 'true');
  const heading = element('div', 'fx-map-heading');
  heading.append(segmented('Map shape', [['rings', 'Sunburst'], ['tiles', 'Treemap']], shape, value => {
    rememberMapShape(value as MapShape);
    panel.replaceWith(mapStub());
  }));
  const canvas = svgElement('svg');
  canvas.classList.add('fx-sunburst-chart');
  canvas.setAttribute('aria-hidden', 'true');
  if (shape === 'tiles') {
    canvas.classList.add('fx-treemap');
    canvas.setAttribute('viewBox', '0 0 400 320');
    const tile = svgElement('rect');
    tile.setAttribute('width', '400');
    tile.setAttribute('height', '320');
    tile.setAttribute('rx', '3');
    canvas.append(tile);
  } else {
    canvas.setAttribute('viewBox', '0 0 400 400');
    const ring = svgElement('circle');
    ring.setAttribute('cx', '200');
    ring.setAttribute('cy', '200');
    ring.setAttribute('r', String((outerRadius + innerRadius) / 2));
    ring.setAttribute('stroke-width', String(outerRadius - innerRadius));
    canvas.append(ring);
  }
  panel.append(heading, canvas, element('p', 'fx-map-summary fx-map-hint fx-map-hint-quiet'));
  return panel;
}

function mapShape(): MapShape {
  try {
    return localStorage.getItem('repometry.map') === 'tiles' ? 'tiles' : 'rings';
  } catch {
    return 'rings';
  }
}

function rememberMapShape(shape: MapShape): void {
  try {
    localStorage.setItem('repometry.map', shape);
  } catch {
    // A private window or blocked storage only loses the remembered choice.
  }
}

const bandMeaning: Record<BuiltinHotspot, string> = {
  complexity: 'Colour shows the most complex function.',
  cognitive: 'Colour shows cognitive complexity relative to the highest file.',
  missedLines: 'Colour shows the share of uncovered lines.',
  duplication: 'Colour shows the share of duplicated code lines.',
  churn: 'Colour shows Git changes relative to the busiest file.',
};
/** The band limits used when the profile sets none. */
const defaultLimits = { complexity: [5, 10, 20, 50], missedLines: [.05, .15, .3, .5], duplication: [.03, .1, .25] } as const;
type ScaledMetric = keyof typeof defaultLimits;
const scaled = (metric: HotspotMetric): metric is ScaledMetric => metric in defaultLimits;

/** The profile's limits for a metric with a meaningful scale, when they are well formed; otherwise the defaults. */
export function bandLimits(details: Pick<InspectionDetails, 'bands'>, metric: HotspotMetric): readonly number[] | undefined {
  if (!scaled(metric)) return undefined;
  const given = details.bands?.[metric];
  const size = defaultLimits[metric].length;
  return given && given.length === size && given.every((value, index) => Number.isFinite(value) && (index === 0 || value > given[index - 1]!))
    ? given : defaultLimits[metric];
}

/** The legend's words for the bands, written from the limits: 1–5, 6–10 … 51+, or <5%, 5–15% … 50%+. */
function bandLabels(metric: ScaledMetric, limits: readonly number[]): string[] {
  const percent = (value: number) => `${+(value * 100).toFixed(1)}%`;
  if (metric === 'complexity') {
    return [...limits.map((limit, index) => `${index === 0 ? 1 : limits[index - 1]! + 1}–${limit}`), `${limits.at(-1)! + 1}+`];
  }
  const ranges = [...limits.map((limit, index) => index === 0 ? `<${percent(limit)}`
    : `${percent(limits[index - 1]!).replace('%', '')}–${percent(limit)}`), `${percent(limits.at(-1)!)}+`];
  return metric === 'duplication' ? ['0%', ...ranges] : ranges;
}

/** Maps a score to one of five colour bands: by the profile's limits where the metric has a meaningful scale. */
/** What the map's colour shows, said to assistive technology. */
function meaningOf(metric: HotspotMetric): string {
  const plugin = pluginSpec(metric);
  if (!plugin) return bandMeaning[metric as BuiltinHotspot];
  return `Colour shows ${plugin.label.toLowerCase()}${plugin.descriptor.bands ? '' : ' relative to the highest file'}.`;
}

export function band(entry: Metrics, metric: HotspotMetric, score: number, highest: number,
  limits: readonly number[] | undefined = scaled(metric) ? defaultLimits[metric] : undefined): number {
  const plugin = pluginSpec(metric);
  if (plugin) return bandOf(plugin, score, highest);
  const step = (value: number, bounds: readonly number[]) => {
    const index = bounds.findIndex(limit => value <= limit);
    return index < 0 ? bounds.length : index;
  };
  if (metric === 'complexity') return step(score, limits!);
  if (metric === 'missedLines') {
    const total = entry.lineCoverage?.total ?? 0;
    return total > 0 ? step(score / total, limits!) : 0;
  }
  if (metric === 'duplication') {
    const lines = entry.quality?.codeLines ?? 0;
    return score === 0 ? 0 : lines > 0 ? 1 + step(score / lines, limits!) : 0;
  }
  return Math.min(4, Math.floor(score / highest * 5));
}

/** Security levels on the map, as the security mark names them: none, low, medium, high, critical. */
const securityLevels = ['No security findings', 'Low', 'Medium', 'High', 'Critical'] as const;

/** Each file's worst level spread to the folders above it. */
export function spreadLevels(files: ReadonlyMap<string, number>): Map<string, number> {
  const spread = new Map(files);
  for (const [path, level] of files) {
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
      const folder = path.slice(0, slash);
      spread.set(folder, Math.max(level, spread.get(folder) ?? 0));
    }
  }
  return spread;
}

function levelLegend(): HTMLElement {
  const legend = element('p', 'fx-scale fx-note fx-scale-labelled');
  const bar = element('span', 'fx-scale-bar');
  bar.setAttribute('aria-hidden', 'true');
  const words = element('span', 'fx-scale-words');
  for (const [index, word] of ['None', 'Low', 'Medium', 'High', 'Critical'].entries()) {
    const swatch = element('span');
    swatch.dataset.band = String(index);
    bar.append(swatch);
    words.append(element('span', '', word));
  }
  legend.dataset.palette = 'grade';
  legend.append(bar, words);
  return legend;
}

function sunburstLegend(metric: HotspotMetric, limits: readonly number[] | undefined): HTMLElement {
  const legend = element('p', 'fx-scale fx-note');
  const plugin = pluginSpec(metric);
  const labels = plugin ? pluginBandLabels(plugin) ?? undefined : scaled(metric) && limits ? bandLabels(metric, limits) : undefined;
  const bar = element('span', 'fx-scale-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 5; index++) {
    const swatch = element('span');
    swatch.dataset.band = String(index);
    bar.append(swatch);
  }
  if (labels) {
    // Each word stands under its band.
    legend.classList.add('fx-scale-labelled');
    const words = element('span', 'fx-scale-words');
    words.append(...labels.map(label => element('span', '', label)));
    legend.append(bar, words);
  } else legend.append(element('span', '', 'Lower'), bar, element('span', '', 'Higher'));
  return legend;
}

function sectorPath(inner: number, outer: number, first: number, last: number): string {
  const large = last - first > Math.PI ? 1 : 0;
  const radius = (r: number, angle: number) => `${(chartCenter + r * Math.cos(angle)).toFixed(3)},${(chartCenter + r * Math.sin(angle)).toFixed(3)}`;
  if (last - first >= fullCircle - 0.00001) {
    const middle = first + Math.PI;
    return `M${radius(outer, first)} A${outer},${outer} 0 1 1 ${radius(outer, middle)} A${outer},${outer} 0 1 1 ${radius(outer, first)}
      M${radius(inner, first)} A${inner},${inner} 0 1 0 ${radius(inner, middle)} A${inner},${inner} 0 1 0 ${radius(inner, first)} Z`;
  }
  return `M${radius(outer, first)} A${outer},${outer} 0 ${large} 1 ${radius(outer, last)}
    L${radius(inner, last)} A${inner},${inner} 0 ${large} 0 ${radius(inner, first)} Z`;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/**
 * Files by another plugin's metric, worst first. Where lower is better a zero is nothing to fix and stays off the list,
 * as with Repometry's own rankings; where higher is better every measured file ranks.
 */
function pluginRanking(files: readonly Metrics[], spec: NonNullable<ReturnType<typeof pluginSpec>>): Metrics[] {
  const order = compareValues(firstSortAscending(spec));
  return files.flatMap(entry => {
    const value = entryValue(local.index, entry, spec);
    return value === null || (spec.descriptor.better !== 'higher' && value <= 0) ? [] : [{ entry, value }];
  }).sort((a, b) => order(a.value, b.value) || collator.compare(a.entry.path, b.entry.path)).map(({ entry }) => entry);
}

const rankTitles: Record<BuiltinHotspot, string> = {
  complexity: 'Peak cyclomatic complexity',
  cognitive: 'Cognitive complexity',
  missedLines: 'Uncovered lines',
  duplication: 'Duplicated lines',
  churn: 'Git changes',
};

/** What makes the churn count incomplete, when anything does: missing history, a shallow checkout, a capped scan. */
function churnCaveat(window: FileMetricsReport['churnWindow']): string {
  if (!window) return 'Git history is unavailable for this inspection.';
  return [window.shallow ? 'The checkout is shallow, so older changes are missing.' : '',
    window.capReached ? `Only the latest ${count(window.maxCommits)} commits were scanned.` : ''].filter(Boolean).join(' ');
}

function rankFiles(entries: readonly Metrics[], metric: HotspotMetric, navigation: Navigation, hasMeasures: boolean,
  limits: readonly number[] | undefined): HTMLElement {
  const panel = element('section', 'fx-rank');
  // The bars speak the map's colours: the same bands, the same palette.
  const plugin = pluginSpec(metric);
  panel.dataset.palette = plugin ? bandScale(plugin) : metric === 'churn' ? 'neutral' : 'heat';
  const heading = rankTitle(metric);
  panel.append(element('h2', '', `${heading} by file`));
  if (!entries.length) {
    panel.append(element('p', 'fx-note', hasMeasures
      ? `No files with ${heading.toLowerCase()} above zero.`
      : `No measurements for ${heading.toLowerCase()} in this folder.`));
    return panel;
  }
  const list = element('ol', 'fx-ranking');
  const navigationState = navigationButtons('Ranking pages', () => { page--; render(); }, () => { page++; render(); });
  navigationState.section.hidden = entries.length <= maxRanked;
  // The longest bar is the highest value, whichever end of the scale the list starts from.
  const peak = entries.reduce((max, entry) => Math.max(max, hotspotScore(entry, metric) ?? 0), 0) || 1;
  let page = 0;
  function render(): void {
    const offset = page * maxRanked;
    list.start = offset + 1;
    list.replaceChildren(...entries.slice(offset, offset + maxRanked).map(entry => {
      const row = element('li');
      const title = link(fileHref(navigation, entry.path), basename(entry.path), 'fx-rank-link');
      const path = element('span', 'fx-rank-path', parentPath(entry.path) || '/');
      title.append(path);
      const value = hotspotScore(entry, metric) ?? 0;
      const mark = element('span', 'fx-rank-mark');
      mark.style.setProperty('--length', `${value / peak * 100}%`);
      mark.dataset.band = String(band(entry, metric, value, peak, limits));
      mark.setAttribute('aria-hidden', 'true');
      row.append(title, mark, element('strong', 'fx-rank-score', count(value)));
      return row;
    }));
    navigationState.update(page, Math.ceil(entries.length / maxRanked));
  }
  panel.append(list, navigationState.section);
  render();
  return panel;
}

function functionList(functions: InspectionDetails['functions']): HTMLOListElement {
  const list = element('ol', 'fx-function-list');
  list.append(...functions.map(record => {
    const row = element('li');
    const subject = element('div');
    subject.append(element('strong', '', record.line === null ? record.name : `${record.name} · line ${record.line}`));
    row.append(subject, element('strong', 'fx-function-score', count(record.complexity)));
    return row;
  }));
  return list;
}

const issueCategories = {
  structure: 'Structure', duplication: 'Duplication', lint: 'Lint', security: 'Security',
  dependency: 'Dependencies', secret: 'Secrets', infrastructure: 'Infrastructure',
} as const;
const issueLevels = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' } as const;
const levelOrder = { high: 0, medium: 1, low: 2, unknown: 3 } as const;

function issuesView(details: InspectionDetails, navigation: Navigation): HTMLElement {
  const { findings, metrics } = details;
  const view = element('div', 'fx-view fx-events');
  if (findings === undefined) {
    view.append(element('p', 'fx-note', 'Findings are unavailable for this inspection. Reinspect this commit to collect them.'));
    return view;
  }

  const path = navigation.file;
  const scoped = path ? findings.filter(item => atPath(item, path)) : findings;
  if (path) {
    const scope = element('div', 'fx-file-heading');
    scope.append(element('code', 'fx-path', path), link(navigation.href('issues'), 'All findings', 'fx-inline-link'));
    view.append(scope);
  }
  if (!scoped.length) {
    view.append(element('p', 'fx-note', path ? 'No findings recorded for this file.' : 'No findings recorded for this commit.'));
    return view;
  }

  // One line of controls, as on Metrics: a search, the severities as a switch, and selects that appear only where they
  // can narrow something. The counts live in the sidebar, which follows the filters.
  const search = searchField('Search findings', 'Search rules, messages and paths');
  search.label.classList.add('fx-field-bare');
  // A link may arrive with a search, as the Profile's rules do: the list opens narrowed to it.
  search.input.value = navigation.query ?? '';
  const present = (['high', 'medium', 'low', 'unknown'] as const).filter(value => scoped.some(item => item.level === value));
  // A link may name a severity and categories, as the Overview's figures do: the list opens filtered, the controls show it.
  let level: string = present.find(value => value === navigation.level) ?? '';
  const severity = segmented('Severity', [['', 'All'], ...present.map(value => [value, issueLevels[value]] as const)], level, value => {
    level = value;
    reset();
  });
  const tally = (values: readonly string[], labels?: Readonly<Record<string, string>>) => choices('', values, labels).slice(1)
    .map(([value, name]) => [value, name, values.filter(item => item === value).length] as const);
  const tools = multiChoice('Tool', 'All tools', 'tools', tally(scoped.map(item => item.tool)), reset);
  const category = multiChoice('Category', 'All categories', 'categories', tally(scoped.map(item => item.category), issueCategories), reset,
    navigation.category?.split(','));
  const toolbar = element('div', 'fx-tools fx-metrics-tools');
  toolbar.append(search.label);
  if (present.length > 1) toolbar.append(severity);
  toolbar.append(category.element, tools.element);
  const status = element('p', 'fx-note fx-results');
  status.setAttribute('aria-live', 'polite');
  const list = element('div', 'fx-issue-list');
  const nav = navigationButtons('Finding pages', () => { page--; render(); }, () => { page++; render(); });
  const split = element('div', 'fx-split');
  const main = element('div', 'fx-main');
  main.append(toolbar, status, list, nav.section);
  let aside = element('aside');
  split.append(main, splitter(split), aside);
  view.append(split);
  const files = new Set(metrics.files.map(entry => entry.path));
  let page = 0;

  function render(): void {
    const query = search.input.value.trim().toLowerCase();
    const groups = new Map<string, Finding[]>();
    const chosen: Finding[] = [];
    for (const item of scoped) {
      if ((tools.values.size && !tools.values.has(item.tool))
        || (category.values.size && !category.values.has(item.category))
        || (level && item.level !== level)
        || !contains(query, [item.rule, item.message, item.path, ...(item.related?.map(location => location.path) ?? [])])) continue;
      chosen.push(item);
      const key = JSON.stringify([item.tool, item.rule, item.category, item.level]);
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    const sorted = [...groups.values()].sort((a, b) => levelOrder[a[0]!.level] - levelOrder[b[0]!.level]
      || b.length - a.length || collator.compare(a[0]!.rule, b[0]!.rule));
    const rows = sorted.slice(page * pageSize, (page + 1) * pageSize);
    list.replaceChildren(...rows.map(group => issueGroup(group, navigation, files)));
    // The sidebar carries the counts; on screen this line speaks only when nothing matches, and it tells a screen
    // reader what the filters left.
    status.textContent = chosen.length === 0 ? 'No findings match these filters.'
      : `${quantity(chosen.length, 'finding')} in ${quantity(groups.size, 'rule')}`;
    status.classList.toggle('visually-hidden', chosen.length > 0);
    nav.section.hidden = sorted.length <= pageSize;
    nav.update(page, Math.ceil(sorted.length / pageSize));
    const next = issueSummary(chosen, groups.size, navigation, files);
    aside.replaceWith(next);
    aside = next;
  }

  function reset(): void {
    page = 0;
    remember();
    render();
  }
  /** The URL follows the filters, without a new history entry per change, so the view can be shared and reloaded. */
  function remember(): void {
    history.replaceState(history.state, '', navigation.href('issues', {
      ...(path ? { file: path } : {}), query: search.input.value.trim(), level,
      category: [...category.values].join(','),
    }));
  }
  search.input.addEventListener('input', reset);
  render();
  return view;
}

/** Totals for the findings the filters select: how many, how much work, of what kind, and where they gather. */
function issueSummary(findings: readonly Finding[], rules: number, navigation: Navigation, files: ReadonlySet<string>): HTMLElement {
  const panel = element('aside', 'fx-aside');
  panel.setAttribute('aria-label', 'Findings summary');
  const heading = element('div', 'fx-aside-heading');
  heading.append(element('h2', '', 'Findings'));
  const facts = element('dl', 'fx-kv');
  facts.append(fact('Findings', count(findings.length)), fact('Rules', count(rules)));
  const effort = findings.reduce((sum, item) => sum + (item.effortMinutes ?? 0), 0);
  if (findings.some(item => item.effortMinutes !== undefined)) facts.append(fact('Estimated effort', duration(effort)));
  // One severity would only repeat the total.
  const levels = (['high', 'medium', 'low', 'unknown'] as const).map(value => [value, findings.filter(item => item.level === value).length] as const)
    .filter(([, total]) => total > 0);
  if (levels.length > 1) for (const [value, total] of levels) facts.append(fact(issueLevels[value], count(total)));
  panel.append(heading, facts);
  const categories = new Map<string, number>();
  for (const item of findings) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  if (categories.size > 1) {
    const section = element('section', 'fx-aside-section');
    const rows = element('dl', 'fx-kv');
    for (const [name, total] of [...categories].sort((a, b) => b[1] - a[1])) {
      rows.append(fact(issueCategories[name as keyof typeof issueCategories] ?? name, count(total)));
    }
    section.append(element('h3', '', 'By category'), rows);
    panel.append(section);
  }
  const places = new Map<string, number>();
  for (const item of findings) for (const location of new Set(allLocations(item).map(place => place.path))) places.set(location, (places.get(location) ?? 0) + 1);
  if (places.size) {
    const section = element('section', 'fx-aside-section');
    const top = element('ol', 'fx-function-list fx-top-files');
    for (const [file, total] of [...places].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 5)) {
      const row = element('li');
      const name = files.has(file) ? link(navigation.href('issues', { file }), basename(file), 'fx-top-file') : element('span', 'fx-top-file', basename(file));
      name.title = file;
      row.append(name, element('strong', 'fx-function-score', count(total)));
      top.append(row);
    }
    section.append(element('h3', '', 'Most affected files'), top);
    panel.append(section);
  }
  return panel;
}

function issueGroup(group: readonly Finding[], navigation: Navigation, files: ReadonlySet<string>): HTMLDetailsElement {
  const item = group[0]!;
  const details = element('details', 'fx-issue');
  const summary = element('summary', 'fx-issue-summary');
  const identity = element('span');
  const title = element('strong', '', item.rule);
  const tool = element('span', 'fx-note', `${item.tool} · ${issueCategories[item.category] ?? item.category}`);
  identity.append(title, tool);
  const severity = element('span', 'fx-state', issueLevels[item.level]);
  severity.dataset.state = item.level;
  const effort = group.reduce((sum, finding) => sum + (finding.effortMinutes ?? 0), 0);
  summary.append(identity, severity, element('span', 'fx-issue-count', group.some(finding => finding.effortMinutes !== undefined)
    ? `${quantity(group.length, 'occurrence')} · ${duration(effort)}` : quantity(group.length, 'occurrence')));
  const locations = element('ul', 'fx-event-list fx-occurrences');
  // The occurrences, and the source they load, are built when the group is first opened: a page of closed groups
  // requests nothing.
  details.addEventListener('toggle', () => { if (details.open && !locations.childElementCount) locations.append(...group.map(occurrence)); });
  function occurrence(finding: Finding): HTMLLIElement {
    const row = element('li', 'fx-occurrence');
    const places = allLocations(finding);
    const primary = places[0];
    // Each occurrence is bound to its code: the place, the message, and the lines themselves.
    const head = element('div', 'fx-occurrence-head');
    if (primary) {
      const label = formatLocation(primary);
      head.append(files.has(primary.path)
        ? link(navigation.href('metrics', { directory: parentPath(primary.path), file: primary.path, ...(primary.line ? { line: primary.line } : {}) }), label, 'fx-location')
        : element('code', 'fx-location', label));
    }
    if (finding.effortMinutes !== undefined) head.append(element('span', 'fx-occurrence-effort', duration(finding.effortMinutes)));
    const message = element('p', 'fx-occurrence-message', finding.message);
    row.append(head, message);
    const start = primary?.line;
    if (primary && start !== undefined && files.has(primary.path) && navigation.source) {
      const slot = element('div', 'fx-occurrence-code');
      row.append(slot);
      void navigation.source(primary.path).then(text => {
        if (text === null) {
          // An excerpt that cannot load leaves no gap; where the forge has the file, the place is one link away.
          const page = navigation.sourcePage?.(primary.path, start);
          if (!page) { slot.remove(); return; }
          const away = link(page.href, `View on ${page.provider}`, 'fx-source-forge');
          away.target = '_blank';
          away.rel = 'noopener noreferrer';
          slot.replaceChildren(away);
          slot.classList.add('fx-occurrence-away');
          return;
        }
        slot.append(renderExcerpt(text, { path: primary.path, line: start, endLine: primary.endLine,
          more: line => navigation.href('metrics', { directory: parentPath(primary.path), file: primary.path, line }) }));
        // A tool that could not name the function said "(anonymous)"; its first line says which one it is.
        const snippet = lineSnippet(text, start, 48);
        if (snippet && finding.message.startsWith('(anonymous)')) {
          const name = element('code', 'fx-occurrence-name');
          name.append(...highlightCode(primary.path, snippet));
          message.replaceChildren(name, finding.message.slice('(anonymous)'.length));
        }
      });
    }
    const others = places.slice(1);
    if (others.length) {
      const paths = element('ul', 'fx-event-paths');
      paths.append(...others.map(location => {
        const path = element('li');
        const label = formatLocation(location);
        path.append(files.has(location.path)
          ? link(navigation.href('metrics', { directory: parentPath(location.path), file: location.path, ...(location.line ? { line: location.line } : {}) }), `Also ${label}`, 'fx-inline-link')
          : element('code', 'fx-path', label));
        return path;
      }));
      row.append(paths);
    }
    const ignore = ignoreSnippet(finding);
    if (ignore) row.append(ignore);
    return row;
  }
  details.append(summary, locations);
  return details;
}

function ignoreSnippet(finding: Finding): HTMLDetailsElement | undefined {
  const { tool, rule, path } = finding;
  if ([tool, rule].some(value => !value.trim() || /[\0\r\n]/.test(value))) return undefined;
  const pathIsLiteral = Boolean(path && !/[\0\r\n\\*?{}[\]()]/.test(path) && !/^[#!]|^[a-z]:/i.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'));
  const record = { tool, rule, ...(pathIsLiteral ? { path } : {}) };

  const details = element('details', 'fx-ignore');
  const title = element('summary', '', 'Ignore rule');
  const hint = element('p', 'fx-note', 'Add this entry to the profile’s ignore array and rerun the inspection. '
    + (pathIsLiteral ? 'It matches this rule in the file shown.' : 'It matches this rule across the repository.'));
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
  let reset: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(input.value);
      copy.classList.add('fx-copied');
      copy.title = 'Copied';
      feedback.textContent = 'Copied.';
      feedback.classList.add('visually-hidden');
      reset = setTimeout(() => {
        copy.classList.remove('fx-copied');
        copy.title = 'Copy rule';
        feedback.textContent = '';
      }, 1500);
    } catch {
      input.focus();
      input.select();
      feedback.classList.remove('visually-hidden');
      feedback.textContent = 'Rule selected. Press your copy shortcut.';
    }
  });
  const code = element('div', 'fx-ignore-box');
  code.append(input, copy);
  details.append(title, hint, code, feedback);
  return details;
}

/** The common copy glyph, two offset sheets, with the check it turns into once copied. */
export function copyIcon(): SVGSVGElement {
  const svg = svgElement('svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { class: 'fx-copy-sheets', x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' }],
    ['path', { class: 'fx-copy-sheets', d: 'M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5' }],
    ['path', { class: 'fx-copy-check', d: 'M3 8.5l3 3 7-7' }],
  ];
  for (const [tag, attributes] of shapes) {
    const shape = svgElement(tag as 'path');
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

interface Location {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
}

function allLocations(finding: Finding): readonly Location[] {
  return [
    ...(finding.path ? [{ path: finding.path, line: finding.line, endLine: finding.endLine }] : []),
    ...(finding.related ?? []),
  ];
}

function atPath(finding: Finding, path: string): boolean {
  return finding.path === path || (finding.related?.some(location => location.path === path) ?? false);
}

function formatLocation(location: Location): string {
  if (location.line === undefined) return location.path;
  const end = location.endLine !== undefined && location.endLine > location.line ? `–${location.endLine}` : '';
  return `${location.path}:${location.line}${end}`;
}

const diagnosticStates = { failed: 'Failed', blocked: 'Blocked', partial: 'Partial' } as const;

function diagnosticsView(details: InspectionDetails, navigation: Navigation): HTMLElement {
  const { diagnostics, metrics } = details;
  const view = element('section', 'fx-view panel fx-events');
  const path = navigation.file;
  const scoped = path ? diagnostics.filter(row => row.path === path) : diagnostics;
  if (path) {
    const scope = element('div', 'fx-file-heading');
    scope.append(element('code', 'fx-path', path), link(navigation.href('diagnostics'), 'All diagnostics', 'fx-inline-link'));
    view.append(scope);
  }
  if (!scoped.length) {
    view.append(element('p', 'fx-note', path ? 'No analysis diagnostics for this file.' : 'No analysis diagnostics for this commit.'));
    return view;
  }

  const search = searchField('Search diagnostics', 'Operation, path or message');
  const operation = choice('Operation', choices('All operations', scoped.map(row => row.operation)), '');
  const state = choice('State', choices('All states', scoped.map(row => row.state), diagnosticStates), '');
  const tools = element('div', 'fx-tools');
  tools.append(search.label, operation.label, state.label);
  const result = element('p', 'fx-note fx-results');
  result.setAttribute('aria-live', 'polite');
  const events = element('ul', 'fx-event-list');
  const nav = navigationButtons('Diagnostic pages', () => { page--; render(); }, () => { page++; render(); });
  view.append(tools, result, events, nav.section);
  const files = new Set(metrics.files.map(entry => entry.path));
  let page = 0;

  function render(): void {
    const query = search.input.value.trim().toLowerCase();
    const matches = scoped.filter(row => (!state.select.value || state.select.value === row.state)
      && (!operation.select.value || operation.select.value === row.operation)
      && contains(query, [row.operation, row.path, row.message]));
    result.textContent = matches.length ? quantity(matches.length, 'diagnostic') : 'No diagnostics match these filters.';
    events.replaceChildren(...matches.slice(page * pageSize, (page + 1) * pageSize).map(row => {
      const item = element('li');
      const heading = element('div', 'fx-event-heading');
      const state = element('span', 'fx-state', diagnosticStates[row.state]);
      state.dataset.state = row.state;
      heading.append(element('code', 'fx-path', row.operation), state);
      item.append(heading, element('p', '', row.message));
      if (row.path) {
        item.append(files.has(row.path) ? link(fileHref(navigation, row.path), row.path, 'fx-inline-link')
          : element('code', 'fx-path', row.path));
      }
      return item;
    }));
    nav.section.hidden = matches.length <= pageSize;
    nav.update(page, Math.ceil(matches.length / pageSize));
  }

  const reset = () => { page = 0; render(); };
  search.input.addEventListener('input', reset);
  operation.select.addEventListener('change', reset);
  state.select.addEventListener('change', reset);
  render();
  return view;
}

export function navigationButtons(label: string, previous: () => void, next: () => void) {
  const section = element('nav', 'fx-page-buttons');
  section.setAttribute('aria-label', label);
  const back = element('button', 'button', 'Previous');
  const forward = element('button', 'button', 'Next');
  back.type = forward.type = 'button';
  back.addEventListener('click', previous);
  forward.addEventListener('click', next);
  const pageLabel = element('span', 'fx-note');
  pageLabel.setAttribute('aria-live', 'polite');
  section.append(back, pageLabel, forward);
  return { section, update: (page: number, pages: number) => {
    back.disabled = page === 0;
    forward.disabled = page + 1 >= pages;
    pageLabel.textContent = `${count(page + 1)} of ${count(pages)}`;
  } };
}

function breadcrumbs(view: 'metrics' | 'hotspots', navigation: Navigation, directory: string): HTMLElement {
  const nav = element('nav', 'fx-breadcrumbs');
  nav.setAttribute('aria-label', 'Folder path');
  const list = element('ol');
  const leading = element('li');
  if (directory === '') {
    leading.setAttribute('aria-current', 'location');
    leading.textContent = 'repo';
  } else leading.append(link(navigation.href(view), 'repo'));
  list.append(leading);
  const segments = directory === '' ? [] : directory.split('/');
  segments.forEach((part, index) => {
    const item = element('li');
    if (index === segments.length - 1) {
      item.setAttribute('aria-current', 'location');
      item.textContent = part;
    } else item.append(link(navigation.href(view, { directory: segments.slice(0, index + 1).join('/') }), part));
    list.append(item);
  });
  nav.append(list);
  // At the root the trail is a single label that says nothing the page title does not.
  nav.hidden = directory === '';
  return nav;
}

function fact(label: string, value: string, context?: string): HTMLElement {
  const pair = element('div');
  pair.append(element('dt', '', label), element('dd', '', value));
  if (context) pair.append(element('dd', 'fx-note', context));
  return pair;
}

function scrollableTable(table: HTMLTableElement, label: string): HTMLElement {
  const region = element('div', 'table-scroll fx-table-scroll');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', label);
  region.tabIndex = 0;
  region.append(table);
  return region;
}

export function searchField(text: string, placeholder: string) {
  const label = element('label', 'fx-field');
  label.append(element('span', 'fx-field-text', text));
  const input = element('input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.spellcheck = false;
  label.append(input);
  return { label, input };
}

/** Two or three exclusive views as one segmented switch; the pressed segment is the current view. */
function segmented(text: string, options: readonly (readonly [string, string])[], selected: string, change: (value: string) => void): HTMLElement {
  const group = element('div', 'fx-segmented');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', text);
  const buttons = options.map(([value, name]) => {
    const button = element('button', '', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(value === selected));
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
      change(value);
    });
    return button;
  });
  group.append(...buttons);
  return group;
}

/** A details menu that closes on a click elsewhere or on Escape, as a menu does. */
function dismissible(menu: HTMLDetailsElement): void {
  const close = (event: Event) => {
    if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) {
      if (menu.open && event instanceof KeyboardEvent) menu.querySelector('summary')?.focus();
      menu.open = false;
    }
  };
  menu.addEventListener('toggle', () => {
    if (menu.open) {
      document.addEventListener('pointerdown', close, true);
      document.addEventListener('keydown', close);
    } else {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close);
    }
  });
}

/**
 * A dropdown of checkboxes: none ticked means all. The button names what is chosen, so the filter reads at a glance;
 * each option carries its count. It hides itself when there is nothing to choose between.
 */
export function multiChoice(text: string, all: string, plural: string, options: readonly (readonly [string, string, number])[],
  change: () => void, initial: Iterable<string> = []): { element: HTMLDetailsElement; values: Set<string> } {
  const offered = new Set(options.map(([value]) => value));
  const values = new Set([...initial].filter(value => offered.has(value)));
  const menu = element('details', 'fx-columns fx-multi');
  menu.hidden = options.length < 2;
  const summary = element('summary', '', all);
  summary.setAttribute('aria-label', `${text}: ${all}`);
  const list = element('div', 'fx-column-toggles');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', text);
  const names = new Map(options.map(([value, name]) => [value, name]));
  function label(): void {
    const chosen = options.filter(([value]) => values.has(value)).map(([, name]) => name);
    // Two choices read by name, so a filtered view says what it holds; more read as a count.
    summary.textContent = chosen.length === 0 ? all : chosen.length <= 2 ? chosen.join(', ') : `${chosen.length} ${plural}`;
    summary.title = chosen.join(', ');
    summary.setAttribute('aria-label', `${text}: ${chosen.length ? chosen.join(', ') : all}`);
    menu.classList.toggle('fx-multi-active', chosen.length > 0);
  }
  for (const [value, name, count] of options) {
    const row = element('label', 'fx-column-toggle');
    const box = element('input');
    box.type = 'checkbox';
    box.value = value;
    box.checked = values.has(value);
    box.addEventListener('change', () => {
      if (box.checked) values.add(value);
      else values.delete(value);
      label();
      change();
    });
    row.append(box, element('span', 'fx-multi-name', names.get(value) ?? name), element('span', 'fx-multi-count', count.toLocaleString()));
    list.append(row);
  }
  menu.append(summary, list);
  dismissible(menu);
  label();
  return { element: menu, values };
}

function choice(text: string, options: readonly (readonly [string, string])[], selected: string) {
  const label = element('label', 'fx-field');
  label.append(element('span', 'fx-field-text', text));
  const select = element('select');
  for (const [value, name] of options) {
    const option = element('option', '', name);
    option.value = value;
    select.append(option);
  }
  select.value = selected;
  label.append(select);
  return { label, select };
}

function choices<T extends string>(first: string, values: readonly T[], labels?: Readonly<Partial<Record<T, string>>>): [string, string][] {
  const unique = [...new Set(values)].map<[string, string]>(value => [value, labels?.[value] ?? value]);
  return [['', first], ...unique.sort((a, b) => collator.compare(a[1], b[1]))];
}

function fileHref(navigation: Navigation, file: string): string {
  return navigation.href('metrics', { directory: parentPath(file), file });
}

function compare(a: Metrics, b: Metrics, measurement: (row: Metrics) => string | number | null, ascending: boolean): number {
  const left = measurement(a);
  const right = measurement(b);
  if (left === null || right === null) return (left === null ? 1 : 0) - (right === null ? 1 : 0) || collator.compare(a.path, b.path);
  const difference = typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
  return (ascending ? difference : -difference) || collator.compare(a.path, b.path);
}

function hotspotScore(entry: Metrics, metric: HotspotMetric): number | null {
  const plugin = pluginSpec(metric);
  if (plugin) return entryValue(local.index, entry, plugin);
  if (metric === 'complexity') return entry.complexity?.maximum ?? null;
  if (metric === 'cognitive') return entry.quality?.cognitiveComplexity ?? null;
  if (metric === 'duplication') return entry.quality?.duplication?.duplicatedLines ?? null;
  if (metric === 'churn') return entry.quality?.churn ?? null;
  const coverage = entry.lineCoverage;
  return coverage && coverage.total > 0 ? coverage.total - coverage.covered : null;
}

function rankTitle(metric: HotspotMetric): string {
  return pluginSpec(metric)?.label ?? rankTitles[metric as BuiltinHotspot];
}

function scoreLabel(metric: HotspotMetric): string {
  return rankTitle(metric).toLowerCase();
}

function coverageRatio(entry: Metrics): number | null {
  const coverage = entry.lineCoverage;
  return coverage && coverage.total > 0 ? coverage.covered / coverage.total : null;
}

function coverageText(entry: Metrics): string {
  const value = coverageRatio(entry);
  return value === null ? '—' : percent.format(value);
}

function coverageContext(entry: Metrics): string | undefined {
  const value = entry.lineCoverage;
  return value && value.total > 0 ? `${count(value.covered)} of ${count(value.total)} lines` : undefined;
}

function duplicationRatio(entry: Metrics): number | null {
  const value = entry.quality?.duplication;
  return value && value.codeLines > 0 ? value.duplicatedLines / value.codeLines : null;
}

function duplicationText(entry: Metrics): string {
  const value = duplicationRatio(entry);
  return value === null ? '—' : percent.format(value);
}

function duplicationContext(entry: Metrics): string | undefined {
  const value = entry.quality?.duplication;
  return value && value.codeLines > 0 ? `${count(value.duplicatedLines)} of ${count(value.codeLines)} code lines` : undefined;
}

function duration(value: number | null | undefined): string {
  if (value == null) return '—';
  const remainder = value % 60;
  const hours = Math.floor(value / 60);
  const minutes = `${count(remainder)} min`;
  return hours === 0 ? minutes : `${count(hours)} h${remainder === 0 ? '' : ` ${minutes}`}`;
}

function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function inside(path: string, directory: string): boolean {
  return directory === '' || path.startsWith(`${directory}/`);
}

function contains(query: string, strings: readonly (string | undefined)[]): boolean {
  return query === '' || strings.some(value => value?.toLowerCase().includes(query));
}

function count(value: number | null | undefined): string {
  return value == null ? '—' : integer.format(value);
}

function quantity(amount: number, noun: string): string {
  return `${count(amount)} ${noun}${amount === 1 ? '' : 's'}`;
}

function link(href: string, label: string, className?: string): HTMLAnchorElement {
  const result = element('a', className, label);
  result.href = href;
  return result;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, label?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (label) result.textContent = label;
  return result;
}
