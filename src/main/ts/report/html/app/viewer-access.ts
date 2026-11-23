/**
 * What a report can show follows what its export carries, never the host it is served from: the export writes its
 * mode into the page, and a public export has no per-file data.
 */

/** Pages every report can draw from the summary alone. */
const summaryPages: ReadonlySet<string> = new Set(['overview', 'trends']);

/** Pages a public report keeps in the navigation as unavailable, so the reader sees what the full report holds. */
export const unavailableTabs = ['issues', 'hotspots', 'metrics', 'settings'] as const;

/** The export's own mode: `local` from `repometry view`, `private` with details, anything else is public. */
export function isDetailed(mode: string | undefined): boolean {
  return mode === 'local' || mode === 'private';
}

/** Whether a page draws its own content, or shows the public report notice in its place. */
export function pageAccess(page: string, detailed: boolean): 'open' | 'notice' {
  return detailed || summaryPages.has(page) ? 'open' : 'notice';
}

/** The one notice a public report gives, in parts so the command can be set as code and copied. */
export const publicNotice = {
  lead: 'Public report:',
  text: 'history and totals only. To see files, findings and source, run',
  command: 'npx repometry view',
  tail: 'in the repository.',
  /** The same message for the Overview's side panel, which sets the command on a line of its own. */
  panel: 'History and totals only. To see files, findings and source, run this in the repository:',
} as const;
