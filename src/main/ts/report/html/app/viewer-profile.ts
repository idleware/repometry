// The Profile page: how the report is made. The profile the inspection applied (what it reads, what it leaves out,
// the rules and what breaking them costs, the rules it was told to skip) and, beside it, the badges with their scales.
import type { InspectionContext } from '../../json/wire/inspection-context-model.js';
import type { InspectionDetails, ProfileSettings } from '../../json/wire/inspection-details-model.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';
import { count, element } from './viewer-dom.js';
import { splitter } from './viewer-layout.js';
import { duration } from './viewer-metrics.js';
import { badges } from './viewer-profile-badges.js';
import type { Latest } from './viewer-profile-badges.js';
import { pagedTable } from './viewer-profile-table.js';

export interface ProfileData {
  readonly report: PublicHistoryEntry;
  readonly context: InspectionContext | undefined;
  /** Present in local and private views: the applied profile travels with them. */
  readonly details: InspectionDetails | undefined;
  /** The newest inspection, which the badges show, with its quality and context. */
  readonly latest: Latest;
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
  split.append(main, splitter(split), badges(data.latest, data.details));
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
