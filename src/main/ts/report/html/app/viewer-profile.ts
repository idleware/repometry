// The Profile page: how the report is made. The profile the inspection applied (what it reads, what it leaves out,
// the rules and what breaking them costs, the rules it was told to skip) and, beside it, the badges with their scales.
import type { InspectionContext } from '../../json/wire/inspection-context-model.js';
import type { InspectionDetails, ProfileSettings } from '../../json/wire/inspection-details-model.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';
import type { QualitySummary } from '../../json/wire/domain-types.js';
import { copyIcon, multiChoice, navigationButtons, searchField, splitter } from './viewer-files.js';
import { count, duration, securityGrades, securityRisks } from './viewer-metrics.js';

export interface ProfileData {
  readonly report: PublicHistoryEntry;
  readonly context: InspectionContext | undefined;
  /** Present in local and private views: the applied profile travels with them. */
  readonly details: InspectionDetails | undefined;
  /** The newest inspection, which the badges show, with its quality and context. */
  readonly latest: { readonly report: PublicHistoryEntry; readonly quality: QualitySummary | undefined; readonly context: InspectionContext | undefined };
}

/** What each structural rule measures, and in what unit its limit and its cost are counted. */
const ruleNames: Readonly<Record<string, readonly [string, string]>> = {
  'function-complexity': ['Cognitive complexity of a function', 'point'],
  'file-complexity': ['Cognitive complexity of a file', 'point'],
  'function-parameters': ['Parameters of a function', 'parameter'],
  'return-statements': ['Return statements in a function', 'return'],
  'boolean-logic': ['Operators in one condition', 'operator'],
  'nested-control-flow': ['Depth of nested control flow', 'level'],
};
const ruleOrder = Object.keys(ruleNames);

export function renderProfile(container: HTMLElement, data: ProfileData): void {
  const view = element('div', 'fx-view');
  const split = element('div', 'fx-split profile');
  const main = element('div', 'fx-main profile-main');
  const profile = data.details?.profile;
  if (profile) main.append(identity(profile), files(profile), rules(profile), exclusions(profile, data.context));
  else main.append(fallback(data));
  const scanners = data.context?.scanners;
  if (scanners?.length) {
    const section = block('Imported scanners');
    section.append(chips(scanners.map(({ name, version }) => version ? `${name} ${version}` : name)));
    main.append(section);
  }
  split.append(main, splitter(split), badges(data));
  view.append(split);
  container.replaceChildren(view);
}

/** The profile's name and the analyzers it ran, with their versions. */
function identity(profile: ProfileSettings): HTMLElement {
  const section = block('Analyzers');
  const facts = element('dl', 'profile-facts');
  if (profile.id) facts.append(row('Profile', code(profile.id)));
  if (profile.analyzers.length) {
    facts.append(row('Plugins', chips(profile.analyzers.map(analyzer => {
      const tools = Object.entries(analyzer.tools).map(([tool, version]) => `${tool} ${version}`);
      return `${analyzer.id} ${analyzer.version}${tools.length ? ` (${tools.join(', ')})` : ''}`;
    }))));
  }
  if (profile.churn) {
    facts.append(row('Change window', element('span', '', `${count(profile.churn.lookbackDays)} days, at most ${count(profile.churn.maxCommits)} commits`)));
  }
  section.append(facts);
  return section;
}

/** What the inspection reads and what it leaves out, as the patterns the profile states. */
function files(profile: ProfileSettings): HTMLElement {
  const section = block('Files');
  const facts = element('dl', 'profile-facts');
  facts.append(row('Included', profile.extensions.length ? chips(profile.extensions.map(extension => `**/*${extension}`)) : none('Every file')));
  facts.append(row('Excluded paths', profile.excludedPaths.length ? chips(profile.excludedPaths) : none()));
  facts.append(row('Excluded directories', profile.excludedDirectories.length
    ? chips(profile.excludedDirectories.map(directory => `**/${directory}/`)) : none()));
  section.append(facts);
  return section;
}

interface RuleRow { readonly plugin: string; readonly rule: string; readonly measure: string | null; readonly limit: number; readonly limitText: string; readonly minutes: number; readonly cost: string }

/** Every check the profile applies, from every plugin: what it measures, where its limit lies, what each unit past it costs. */
function rules(profile: ProfileSettings): HTMLElement {
  const section = block('Rules');
  const rows: RuleRow[] = profile.rules.map(rule => {
    const [measure, unit] = ruleNames[rule.rule] ?? [null, 'unit'];
    return { plugin: rule.plugin, rule: rule.rule, measure, limit: rule.limit, limitText: count(rule.limit),
      minutes: rule.minutesPerExcess, cost: `${duration(rule.minutesPerExcess)} per ${unit} over` };
  });
  const duplication = profile.duplication;
  if (duplication) {
    rows.push({ plugin: 'duplication', rule: 'identical-code', measure: 'Repeated code', limit: duplication.minCodeLines,
      limitText: `${count(duplication.minCodeLines)} lines, ${count(duplication.minNodes)} nodes`,
      minutes: duplication.minutesPerRepeatedLine, cost: `${duration(duplication.minutesPerRepeatedLine)} per repeated line` });
  }
  rows.sort((a, b) => a.plugin.localeCompare(b.plugin) || order(a.rule) - order(b.rule) || a.rule.localeCompare(b.rule));
  section.append(pagedTable<RuleRow>({
    label: 'Rules', noun: ['rule', 'rules'], rows, empty: 'The profile records no rules.', controls: true,
    search: row => `${row.rule} ${row.plugin} ${row.measure ?? ''}`,
    facet: { text: 'Plugin', all: 'All plugins', plural: 'plugins', key: row => row.plugin },
    columns: [
      { label: 'Rule', cell: row => ruleCell(row.rule, row.measure), sort: row => row.rule },
      { label: 'Plugin', cell: row => element('span', 'profile-plugin', row.plugin), sort: row => row.plugin },
      { label: 'Limit', numeric: true, cell: row => row.limitText, sort: row => row.limit },
      { label: 'Cost', numeric: true, cell: row => row.cost, sort: row => row.minutes },
    ],
  }));
  return section;
}

function ruleCell(name: string, measure: string | null): HTMLElement {
  const cell = element('span');
  cell.append(element('code', 'profile-rule', name));
  if (measure) cell.append(element('span', 'profile-rule-meta', measure));
  return cell;
}

type IgnoreRow = ProfileSettings['ignore'][number];

/** The findings the profile tells the inspection to skip, by tool, rule and path. */
function exclusions(profile: ProfileSettings, context: InspectionContext | undefined): HTMLElement {
  const section = block('Rule exclusions');
  const skipped = context?.ignores?.count;
  if (profile.ignore.length && skipped !== undefined) {
    section.append(element('p', 'detail', `${count(skipped)} ${skipped === 1 ? 'finding' : 'findings'} skipped at this commit.`));
  }
  section.append(pagedTable<IgnoreRow>({
    label: 'Rule exclusions', noun: ['exclusion', 'exclusions'], rows: profile.ignore,
    empty: 'None. “Ignore rule” on an issue gives the entry to add to the profile’s ignore list.',
    search: row => [row.tool, row.rule, row.path, row.reason].filter(Boolean).join(' '),
    facet: { text: 'Tool', all: 'All tools', plural: 'tools', key: row => row.tool ?? 'Any tool' },
    columns: [
      { label: 'Rule', cell: row => code([row.tool, row.rule].filter(Boolean).join(' / ') || 'Any rule'), sort: row => `${row.tool ?? ''} ${row.rule ?? ''}` },
      { label: 'Path', cell: row => row.path ? element('span', 'profile-ignore-path', row.path) : none('Everywhere'), sort: row => row.path ?? '' },
      { label: 'Reason', cell: row => row.reason ?? '', sort: row => row.reason ?? '' },
    ],
  }));
  return section;
}

interface Column<T> {
  readonly label: string;
  readonly numeric?: boolean;
  readonly cell: (row: T) => Node | string;
  readonly sort: (row: T) => string | number;
}

interface TableSpec<T> {
  readonly label: string;
  readonly noun: readonly [string, string];
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly search: (row: T) => string;
  readonly facet?: { readonly text: string; readonly all: string; readonly plural: string; readonly key: (row: T) => string };
  readonly empty: string;
  /** Search and filter even while the list is short: the rules grow with every plugin and stack. */
  readonly controls?: boolean;
}

const tableSize = 50;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * A list that may run to tens of thousands of rows, as a profile's rules and patterns do in a monorepo: searched,
 * narrowed by one facet, sorted by any column, and paged, with the count beside the page buttons as in Metrics.
 * Only the page in view is built.
 */
function pagedTable<T>(spec: TableSpec<T>): HTMLElement {
  const box = element('div', 'profile-table');
  if (!spec.rows.length) {
    box.append(element('p', 'detail', spec.empty));
    return box;
  }
  const haystacks = spec.rows.map(row => spec.search(row).toLowerCase());
  let page = 0;
  let sortBy = -1;
  let ascending = true;
  const reset = () => { page = 0; render(); };
  const tools = element('div', 'fx-tools profile-table-tools');
  const search = searchField(`Search ${spec.noun[1]}`, `Search ${spec.noun[1]}`);
  search.label.classList.add('fx-field-bare');
  search.input.addEventListener('input', reset);
  const facet = spec.facet && multiChoice(spec.facet.text, spec.facet.all, spec.facet.plural, [...spec.rows.reduce((counts, row) => {
    const key = spec.facet!.key(row);
    return counts.set(key, (counts.get(key) ?? 0) + 1);
  }, new Map<string, number>())].sort((a, b) => collator.compare(a[0], b[0])).map(([key, total]) => [key, key, total] as const), reset);
  // A short list needs no controls: it is read at a glance.
  if (spec.controls || spec.rows.length > 10) tools.append(search.label);
  if (facet && !facet.element.hidden) tools.append(facet.element);

  const table = element('table', 'fx-table profile-list');
  table.setAttribute('aria-label', spec.label);
  const head = element('tr');
  const headers = spec.columns.map((column, index) => {
    const cell = element('th', column.numeric ? 'numeric' : '');
    cell.scope = 'col';
    const button = element('button', 'fx-sort', column.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      ascending = sortBy === index ? !ascending : !column.numeric;
      sortBy = index;
      reset();
    });
    cell.append(button);
    head.append(cell);
    return cell;
  });
  const thead = element('thead');
  thead.append(head);
  const body = element('tbody');
  table.append(thead, body);
  const frame = element('div', 'table-scroll fx-table-scroll');
  frame.append(table);
  const pager = element('div', 'fx-pager');
  const result = element('p', 'fx-note fx-results');
  result.setAttribute('aria-live', 'polite');
  const buttons = navigationButtons(`${spec.label} pages`, () => { page -= 1; render(); }, () => { page += 1; render(); });
  pager.append(result, buttons.section);
  if (tools.childElementCount) box.append(tools);
  box.append(frame, pager);

  function render(): void {
    const words = search.input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const chosen = facet?.values;
    let shown = spec.rows.flatMap((row, index) => (!chosen?.size || chosen.has(spec.facet!.key(row)))
      && words.every(word => haystacks[index]!.includes(word)) ? [row] : []);
    if (sortBy >= 0) {
      const key = spec.columns[sortBy]!.sort;
      const direction = ascending ? 1 : -1;
      shown = shown.sort((a, b) => {
        const left = key(a);
        const right = key(b);
        return direction * (typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right)));
      });
    }
    for (const [index, cell] of headers.entries()) {
      if (index === sortBy) cell.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      else cell.removeAttribute('aria-sort');
    }
    const pages = Math.max(1, Math.ceil(shown.length / tableSize));
    page = Math.min(page, pages - 1);
    const visible = shown.slice(page * tableSize, (page + 1) * tableSize);
    body.replaceChildren(...visible.map(row => {
      const line = element('tr');
      for (const column of spec.columns) {
        const cell = element('td', column.numeric ? 'numeric' : '');
        cell.append(column.cell(row));
        line.append(cell);
      }
      return line;
    }));
    frame.hidden = shown.length === 0;
    const [one, many] = spec.noun;
    const filtered = shown.length !== spec.rows.length;
    result.textContent = shown.length === 0 ? `No ${many} match.`
      : shown.length > tableSize ? `${count(page * tableSize + 1)}–${count(page * tableSize + visible.length)} of ${count(shown.length)} ${many}`
      : filtered ? `${count(shown.length)} of ${count(spec.rows.length)} ${many}`
      : `${count(shown.length)} ${shown.length === 1 ? one : many}`;
    buttons.section.hidden = shown.length <= tableSize;
    buttons.update(page, pages);
  }
  render();
  return box;
}

/** Until the details arrive only the exclusions are known; the summary does not carry the profile itself. */
function fallback(data: ProfileData): HTMLElement {
  const section = block('Files');
  const exclusions = data.context?.exclusions;
  if (exclusions) {
    const facts = element('dl', 'profile-facts');
    facts.append(row('Excluded paths', exclusions.paths.length ? chips(exclusions.paths) : none()));
    facts.append(row('Excluded directories', exclusions.directories.length ? chips(exclusions.directories.map(directory => `**/${directory}/`)) : none()));
    section.append(facts);
  }
  if (data.details) section.append(element('p', 'detail', 'This inspection did not record its profile.'));
  return section;
}

type Format = 'markdown' | 'html';
const formatKey = 'repometry.badge-format';

/** A grade letter, the range it stands for, and an optional word for its colour's meaning. */
type Step = readonly [string, string, string?];

/** The badges as a README shows them: each with the scale it grades by, and the snippet that embeds it. */
function badges(data: ProfileData): HTMLElement {
  const panel = element('aside', 'fx-aside profile-aside');
  panel.setAttribute('aria-label', 'Badges');
  const heading = element('div', 'fx-aside-heading');
  heading.append(element('h2', '', 'Badges'));
  let format: Format = 'markdown';
  try {
    if (localStorage.getItem(formatKey) === 'html') format = 'html';
  } catch {
    // Blocked storage only forgets the choice.
  }
  const snippets: (() => void)[] = [];
  const toggle = element('div', 'fx-segmented profile-format');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Snippet format');
  for (const [value, label] of [['markdown', 'Markdown'], ['html', 'HTML']] as const) {
    const button = element('button', '', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(value === format));
    button.addEventListener('click', () => {
      format = value;
      for (const other of toggle.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      try {
        localStorage.setItem(formatKey, value);
      } catch {
        // As above.
      }
      for (const update of snippets) update();
    });
    toggle.append(button);
  }
  heading.append(toggle);
  panel.append(heading);

  const { report, quality, context } = data.latest;
  const lines = report.lineCoverage;
  const coverage = lines && lines.total > 0 ? lines.covered / lines.total : null;
  const ratio = quality?.maintainability?.debtRatio ?? null;
  const security = context?.security;
  const worst = !security ? null : security.critical ? 4 : security.high ? 3 : security.medium ? 2 : security.low || security.unknown ? 1 : 0;
  const areas: [string, string, Step[], number | null, boolean][] = [
    ['maintainability', 'Maintainability', [['A', '<5%'], ['B', '<10%'], ['C', '<20%'], ['D', '<50%'], ['F', '50%+']],
      ratio === null ? null : [.05, .1, .2, .5, Infinity].findIndex(limit => ratio < limit), true],
    ['coverage', 'Coverage', [['A', '90%+'], ['B', '80%+'], ['C', '70%+'], ['D', '60%+'], ['F', '<60%']],
      coverage === null ? null : [.9, .8, .7, .6, -Infinity].findIndex(limit => coverage >= limit), true],
    ['security', 'Security', securityGrades.map((grade, index) => [grade, securityRisks[index]!] as const), worst, security !== undefined],
  ];
  for (const [name, label, steps, current, published] of areas) {
    const section = element('section', 'fx-aside-section profile-badge-area');
    section.append(element('h3', '', label));
    if (published) {
      const image = element('img', 'profile-badge');
      image.src = `./${name}.svg`;
      image.alt = `${label} badge`;
      image.height = 22;
      section.append(image);
    }
    section.append(scale(steps, current));
    if (published) {
      const url = new URL(`./${name}.svg`, location.href).href;
      const home = new URL('./', location.href).href;
      const box = element('div', 'profile-snippet');
      const text = element('code');
      box.append(text, copyButton(`Copy the ${label.toLowerCase()} badge snippet`, () => text.textContent ?? ''));
      const update = () => {
        text.textContent = format === 'markdown' ? `[![${label}](${url})](${home})`
          : `<a href="${home}"><img src="${url}" alt="${label}"></a>`;
      };
      update();
      snippets.push(update);
      section.append(box);
    } else section.append(element('p', 'fx-note', 'No scanner report, so no badge.'));
    panel.append(section);
  }
  // Footnotes close the sidebar, under the last badge: how the maintainability grade's ratio is made, and what badges show.
  const model = data.details?.profile?.debtModel;
  panel.append(element('p', 'fx-note profile-badge-note', model
    ? `Debt ratio: remediation time over the time to write the code, by ${model.name === 'basic-cocomo-organic' ? 'basic COCOMO (organic)' : model.name}: ${model.scale} × KLOC^${model.exponent} person-months of ${count(Math.round(model.minutesPerPersonMonth / 60))} hours.`
    : 'Debt ratio: remediation time over the estimated time to write the code.'));
  panel.append(element('p', 'fx-note profile-footnote', 'Badges show the latest inspection; their links work once the report is hosted.'));
  return panel;
}

/** The scale as one strip in the grade colours, the latest inspection's step at full strength. */
function scale(steps: readonly Step[], current: number | null): HTMLElement {
  const box = element('div', 'profile-scale');
  const strip = element('div', 'profile-scale-strip');
  const words = element('div', 'profile-scale-words');
  for (const [index, [grade, range, word]] of steps.entries()) {
    const segment = element('span', 'profile-scale-grade', word ?? grade);
    segment.dataset.grade = grade;
    if (index === current) segment.setAttribute('aria-current', 'true');
    strip.append(segment);
    words.append(element('span', '', range));
  }
  box.append(strip, words);
  return box;
}

function copyButton(label: string, text: () => string): HTMLButtonElement {
  const button = element('button', 'fx-copy profile-copy');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(copyIcon());
  let reset: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(text());
      button.classList.add('fx-copied');
      reset = setTimeout(() => button.classList.remove('fx-copied'), 1500);
    } catch {
      // Without clipboard access the snippet is selected, ready for the copy shortcut.
      const range = document.createRange();
      range.selectNodeContents(button.previousElementSibling!);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  });
  return button;
}

function order(rule: string): number {
  const index = ruleOrder.indexOf(rule);
  return index < 0 ? ruleOrder.length : index;
}

function block(title: string): HTMLElement {
  const section = element('section', 'profile-block');
  section.append(element('h3', '', title));
  return section;
}

function row(label: string, value: Node): HTMLElement {
  const item = element('div');
  const detail = element('dd');
  detail.append(value);
  item.append(element('dt', '', label), detail);
  return item;
}

function chips(values: readonly string[]): HTMLElement {
  const list = element('ul', 'profile-chips');
  list.append(...values.map(value => element('li', '', value)));
  return list;
}

function none(text = 'None'): HTMLElement {
  return element('span', 'detail', text);
}

function code(text: string): HTMLElement {
  return element('code', '', text);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
