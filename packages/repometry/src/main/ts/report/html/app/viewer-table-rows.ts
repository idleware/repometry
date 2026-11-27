import type { InspectionDetails } from '../../json/wire/inspection-details-model.js';
import { count, inside, parentPath } from './viewer-dom.js';
import { compareEntries } from './viewer-file-figures.js';
import type { Directory, Metrics } from './viewer-inspection.js';
import { pageSize } from './viewer-inspection.js';
import { aggregate } from './viewer-totals.js';

export type Group = 'folders' | 'files' | 'components';
export type RowKind = 'folder' | 'file' | 'component';
export interface Row {
  readonly entry: Metrics;
  readonly kind: RowKind;
  /** The files a folder's or a component's total is made of. */
  readonly files?: readonly Metrics[];
}
/** A row of the table, or the fold that stands for the ignored ones. */
export type DisplayRow = Row | { readonly kind: 'unread' };

/** The component row for the files no component claims: it cannot be opened as a filter. */
export const notInComponent = 'Not in a component';

export function isGroup(value: string | undefined): value is Group {
  return value === 'folders' || value === 'files' || value === 'components';
}

const folderRow = (entry: Metrics): Row => ({ entry, kind: 'folder' });
const fileRow = (entry: Metrics): Row => ({ entry, kind: 'file' });

/** Components, each totalled over the chosen files it holds, and a last row for the chosen files none holds. */
export function componentRows(components: NonNullable<InspectionDetails['components']>, files: readonly Metrics[], filtering: boolean): Row[] {
  const chosen = new Map(files.map(entry => [entry.path, entry]));
  const rows = components.map(({ component, paths }): Row => ({
    entry: aggregate(component.name, paths.flatMap(path => chosen.get(path) ?? [])), kind: 'component',
    files: paths.flatMap(path => chosen.get(path) ?? []) }))
    .filter(row => !filtering || (row.entry as Directory).files > 0);
  const assigned = new Set(components.flatMap(({ paths }) => paths));
  const rest = files.filter(entry => !assigned.has(entry.path));
  if (rest.length) rows.push({ entry: aggregate(notInComponent, rest), kind: 'component', files: rest });
  return rows;
}

/** A folder's own listing: the folders right under it with their recorded totals, then its files. */
export function folderRows(directories: readonly Directory[], files: readonly Metrics[], directory: string): Row[] {
  const under = (entry: Metrics): Row => ({ ...folderRow(entry), files: files.filter(file => inside(file.path, entry.path)) });
  return [...directories.filter(entry => entry.path && parentPath(entry.path) === directory).map(under),
    ...files.filter(entry => parentPath(entry.path) === directory).map(fileRow)];
}

/** Filtered folders hold only what passes the query, and their totals count only that. */
export function filteredFolderRows(files: readonly Metrics[], directory: string): Row[] {
  const below = new Map<string, Metrics[]>();
  const here: Metrics[] = [];
  const prefix = directory ? `${directory}/` : '';
  for (const entry of files) {
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) here.push(entry);
    else {
      const folder = prefix + rest.slice(0, slash);
      below.set(folder, [...below.get(folder) ?? [], entry]);
    }
  }
  return [...[...below].map(([path, entries]) => ({ ...folderRow(aggregate(path, entries)), files: entries })), ...here.map(fileRow)];
}

/** Sorts in place by a column; sorted by path, folders come before files. */
export function sortRows(rows: Row[], byPath: boolean, value: (entry: Metrics) => string | number | null, ascending: boolean): Row[] {
  return rows.sort((a, b) => {
    const files = Number(a.kind === 'file') - Number(b.kind === 'file');
    return (byPath ? files : 0) || compareEntries(a.entry, b.entry, value, ascending);
  });
}

/**
 * The code comes first, whatever the sort: files no plugin read, and folders holding only such files, fold into one
 * row at the end, open or closed. A query that asks for them (`keep`), or a list of nothing else, shows them as they are.
 */
export function foldUnread(rows: readonly Row[], unreadPaths: ReadonlySet<string>, keep: boolean, expanded: boolean):
  { readonly display: readonly DisplayRow[]; readonly folded: readonly Row[] } {
  const unread = (row: Row) => row.kind === 'file' ? row.entry.analysed === false : row.kind === 'folder' && unreadPaths.has(row.entry.path);
  const folded = keep ? [] : rows.filter(unread);
  const read = rows.filter(row => !folded.includes(row));
  if (!folded.length || !read.length) return { display: rows, folded };
  return { display: [...read, { kind: 'unread' }, ...expanded ? folded : []], folded };
}

/**
 * The entries a page shows, 1-based, counting rows and not the fold of ignored files, which takes a place in the list
 * but is no entry of its own. None where the page holds only the fold.
 */
export function entryRange(display: readonly { readonly kind: string }[], first: number, shown: number): [number, number] | null {
  const entries = (from: number, to: number) => display.slice(from, to).filter(row => row.kind !== 'unread').length;
  const before = entries(0, first);
  const here = entries(first, first + shown);
  return here ? [before + 1, before + here] : null;
}

const nouns: Record<Group, readonly [string, string]> = { components: ['component', 'components'], folders: ['entry', 'entries'],
  files: ['file', 'files'] };

export interface ListCounts {
  /** The rows of the list, without the fold. */
  readonly rows: number;
  /** Rows and the fold, as the pages hold them. */
  readonly display: number;
  /** The files the query selected, and the files of the folder it searched. */
  readonly files: number;
  readonly scope: number;
  /** The first and last entry of the page, where the list has pages. */
  readonly range: readonly [number, number] | null;
}

/**
 * The line under the table. A filtered file list says how many of the folder's files it kept; other lists name the
 * selection only once. An empty list that a hint explains says nothing more.
 */
export function listSummary(group: Group, counts: ListCounts, filtering: boolean, hinted: boolean): string {
  if (counts.rows === 0) return hinted ? '' : 'No files match this selection.';
  const [one, many] = nouns[group];
  const paged = counts.display > pageSize;
  const listsFiles = group === 'files' && counts.rows === counts.files;
  const of = filtering && (paged || !listsFiles) ? ` · ${count(counts.files)} of ${count(counts.scope)} files selected` : '';
  const total = `${count(counts.rows)} ${many}${of}`;
  if (paged) return counts.range ? `${count(counts.range[0])}–${count(counts.range[1])} of ${total}` : total;
  if (filtering && listsFiles) return `${count(counts.rows)} of ${count(counts.scope)} files`;
  return `${count(counts.rows)} ${counts.rows === 1 ? one : many}${of}`;
}
