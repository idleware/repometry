// The Metrics query: one field of chips over files. Languages, components, measurements and paths share one grammar,
// so a selection reads as text, travels in the URL and comes back as chips.
import type { FileMetricsReport } from '../../json/wire/file-metrics-model.js';
import { isIgnored, isLockfile, languageOf } from './viewer-languages.js';
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

type ClauseOf<K extends Clause['kind']> = Extract<Clause, { readonly kind: K }>;
/** One function per kind of clause, each given its own kind. */
type PerKind<T> = { readonly [K in Clause['kind']]: (clause: ClauseOf<K>) => T };

function byKind<T>(table: PerKind<T>, clause: Clause): T {
  return (table[clause.kind] as (clause: Clause) => T)(clause);
}

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

function ratio(part: number | undefined, whole: number | undefined): number | null {
  return part !== undefined && whole !== undefined && whole > 0 ? part / whole : null;
}

const measures: Record<BuiltinMeasure, MeasureSpec> = {
  complexity: { label: labelOf('complexity'), read: entry => entry.complexity?.maximum ?? null },
  cognitive: { label: labelOf('cognitive'), read: entry => entry.quality?.cognitiveComplexity ?? null },
  lines: { label: labelOf('code-lines'), read: entry => entry.quality?.codeLines ?? entry.lines },
  functions: { label: 'Functions', read: entry => entry.functions },
  coverage: { label: labelOf('coverage'), percent: true, read: entry => ratio(entry.lineCoverage?.covered, entry.lineCoverage?.total) },
  duplication: { label: 'Duplication', percent: true,
    read: entry => ratio(entry.quality?.duplication?.duplicatedLines, entry.quality?.duplication?.codeLines) },
  remediation: { label: labelOf('effort'), minutes: true, read: entry => entry.quality?.maintainability?.effortMinutes ?? null },
  changes: { label: 'Git changes', read: entry => entry.quality?.churn ?? null },
};

/** Other plugins' metrics, by key, for the inspection on screen. */
let pluginMeasures = new Map<string, MeasureSpec>();

export function usePluginMeasures(entries: Iterable<readonly [string, MeasureSpec]>): void {
  pluginMeasures = new Map(entries);
}

/** Other plugins' metrics the query can name, by key. */
export function pluginMeasureList(): readonly (readonly [string, MeasureSpec])[] {
  return [...pluginMeasures];
}

export function measureOf(name: string): MeasureSpec | undefined {
  return name in measures ? measures[name as BuiltinMeasure] : pluginMeasures.get(name);
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

/** A condition's number in the measure's own unit: a ratio for percentages (80 and 80% alike), minutes for hours. */
function conditionValue(spec: MeasureSpec, number: number, unit: string | undefined): number {
  if (spec.percent) return unit === '%' || number > 1 ? number / 100 : number;
  return unit === 'h' ? number * 60 : number;
}

export function parseWord(word: string): Clause | null {
  const keyedWord = /^(\w+):(.+)$/.exec(word);
  if (keyedWord) return keyed(keyedWord[1]!, keyedWord[2]!);
  const condition = /^([\w.-]+)(>=|<=|>|<|=)(\d+(?:\.\d+)?)(%|h|min)?$/i.exec(word);
  if (!condition) return word ? { kind: 'path', value: word } : null;
  const measure = condition[1]!.toLowerCase();
  const spec = measureOf(measure);
  if (!spec) return null;
  return { kind: 'measure', measure, operator: condition[2] as Operator, value: conditionValue(spec, Number(condition[3]), condition[4]?.toLowerCase()) };
}

const yesNo = (value: string): value is 'yes' | 'no' => value === 'yes' || value === 'no';
const flag = <K extends 'analysed' | 'lockfile'>(kind: K, read: (value: 'yes' | 'no') => 'yes' | 'no' = value => value) =>
  (value: string): Clause | null => yesNo(value) ? { kind, value: read(value) } as Clause : null;
const named = (kind: 'lang' | 'component' | 'path') => (value: string): Clause => ({ kind, value });

/** The keys a clause is written with. The interface calls the files no plugin read "ignored"; `analysed:` stays a silent alias. */
const keys: ReadonlyMap<string, (value: string) => Clause | null> = new Map([
  ['lang', named('lang')], ['language', named('lang')],
  ['component', named('component')],
  ['path', named('path')], ['in', named('path')],
  ['has', (value: string): Clause | null => value === 'findings' || value === 'diagnostics' ? { kind: 'has', value } : null],
  ['analysed', flag('analysed')], ['analyzed', flag('analysed')],
  ['ignored', flag('analysed', value => value === 'yes' ? 'no' : 'yes')],
  ['lockfile', flag('lockfile')], ['lockfiles', flag('lockfile')],
]);

function keyed(key: string, value: string): Clause | null {
  return keys.get(key.toLowerCase())?.(value) ?? null;
}

export function formatQuery(clauses: readonly Clause[]): string {
  return clauses.map(clauseText).join(' ');
}

const quoted = (value: string) => /\s|"/.test(value) ? `"${value.replaceAll('"', '')}"` : value;

/** A measure's bound as written: percentages as percentages, everything else as the number. */
function boundText(clause: ClauseOf<'measure'>): string {
  return measureOf(clause.measure)?.percent ? `${Math.round(clause.value * 1000) / 10}%` : String(clause.value);
}

/** A path that reads as anything else is written out as one. */
function pathText(value: string): string {
  return /^\w+:|[<>=]/.test(value) || /\s/.test(value) ? `path:${quoted(value)}` : value;
}

const clauseTexts: PerKind<string> = {
  lang: clause => `lang:${quoted(clause.value)}`,
  component: clause => `component:${quoted(clause.value)}`,
  path: clause => pathText(clause.value),
  has: clause => `has:${clause.value}`,
  analysed: clause => `ignored:${clause.value === 'no' ? 'yes' : 'no'}`,
  lockfile: clause => `lockfile:${clause.value}`,
  measure: clause => `${clause.measure}${clause.operator}${boundText(clause)}`,
};

export function clauseText(clause: Clause): string {
  return byKind(clauseTexts, clause);
}

const operatorSigns: Readonly<Record<Operator, string>> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '=': '=' };
const yesNoWords = { yes: 'Yes', no: 'No' } as const;

function measureLabel(clause: ClauseOf<'measure'>): { key: string; value: string } {
  const { label, percent, minutes } = measureOf(clause.measure) ?? { label: clause.measure };
  const bound = percent ? `${Math.round(clause.value * 1000) / 10}%` : minutes ? `${clause.value} min` : String(clause.value);
  return { key: label, value: `${operatorSigns[clause.operator]} ${bound}` };
}

const clauseLabels: PerKind<{ key: string; value: string }> = {
  lang: clause => ({ key: 'Language', value: clause.value }),
  component: clause => ({ key: 'Component', value: clause.value }),
  path: clause => ({ key: 'Path', value: clause.value }),
  has: clause => ({ key: 'Has', value: clause.value }),
  analysed: clause => ({ key: 'Ignored', value: clause.value === 'no' ? 'Yes' : 'No' }),
  lockfile: clause => ({ key: 'Lockfile', value: yesNoWords[clause.value] }),
  measure: measureLabel,
};

/** The chip's words: what it selects, in the interface's language rather than the query's. */
export function clauseLabel(clause: Clause): { key: string; value: string } {
  return byKind(clauseLabels, clause);
}

export function sameClause(a: Clause, b: Clause): boolean {
  return clauseText(a) === clauseText(b);
}

const comparisons: Readonly<Record<Operator, (value: number, bound: number) => boolean>> = {
  '>': (value, bound) => value > bound,
  '>=': (value, bound) => value >= bound,
  '<': (value, bound) => value < bound,
  '<=': (value, bound) => value <= bound,
  '=': (value, bound) => value === bound,
};

/** The conditions every file must meet; languages, components and paths widen within their kind instead. */
type Conditions = (clause: Clause, entry: FileEntry, facts: FileFacts) => boolean;

const conditions: Readonly<Partial<Record<Clause['kind'], Conditions>>> = {
  has: (clause, entry, facts) => (clause as ClauseOf<'has'>).value === 'findings' ? (facts.findings.get(entry.path) ?? 0) > 0 : entry.diagnosticCount > 0,
  analysed: (clause, entry) => isIgnored(entry) === (clause.value === 'no'),
  lockfile: (clause, entry) => isLockfile(entry.path) === (clause.value === 'yes'),
  measure: (clause, entry) => {
    const { measure, operator, value: bound } = clause as ClauseOf<'measure'>;
    const value = measureOf(measure)?.read(entry) ?? null;
    return value !== null && comparisons[operator](value, bound);
  },
};

/** Whether the file passes the chips of one kind: any of them, or no chip of that kind at all. */
function anyOf(clauses: readonly Clause[], kind: 'lang' | 'component' | 'path', test: (value: string) => boolean): boolean {
  const values = clauses.flatMap(clause => clause.kind === kind ? [clause.value.toLowerCase()] : []);
  return values.length === 0 || values.some(test);
}

/**
 * Whether a file passes the query. Chips of one kind widen the selection (TypeScript or JavaScript), chips of
 * different kinds narrow it (TypeScript in the core component), and every condition must hold.
 */
export function matches(entry: FileEntry, clauses: readonly Clause[], facts: FileFacts, text = ''): boolean {
  const path = entry.path.toLowerCase();
  const language = languageOf(entry).toLowerCase();
  const components = (facts.components.get(entry.path) ?? []).map(name => name.toLowerCase());
  const widened = [
    path.includes(text.toLowerCase()),
    anyOf(clauses, 'lang', value => language === value),
    anyOf(clauses, 'component', value => components.includes(value)),
    anyOf(clauses, 'path', value => path.includes(value)),
  ];
  return widened.every(Boolean) && clauses.every(clause => conditions[clause.kind]?.(clause, entry, facts) ?? true);
}
