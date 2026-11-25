import type { FindingLocation } from '../../core/model/finding.js';
import { annotationLimit } from '../../core/model/pull-review.js';
import type { IssueEffect, PullReview, ReviewedIssue, ReviewReason } from '../../core/model/pull-review.js';

/** The first line of every review comment, which finds the comment to update. */
export const reviewMarker = '<!-- repometry-review -->';
const maxLength = 60_000;
const groups: readonly { readonly effect: IssueEffect; readonly title: string; readonly folded: boolean }[] = [
  { effect: 'new', title: 'New', folded: false }, { effect: 'worsened', title: 'Worsened', folded: false },
  { effect: 'improved', title: 'Improved', folded: true }, { effect: 'touched', title: 'Touched', folded: true },
];
const verdicts: Readonly<Record<PullReview['verdict'], string>> = { passed: 'Passed', failed: 'Failed', unmeasured: 'Not measured' };

/** The review as Markdown: the run summary and the pull request comment carry the same text. */
export function pullReviewMarkdown(review: PullReview): string {
  const head = [reviewMarker, `## Repometry${review.number === null ? ' review' : ` · PR #${review.number}`}`, '', headline(review), '',
    ...facts(review).map(line => `- ${line}`), ''];
  const annotated = review.issues.filter(issue => issue.effect === 'new' || issue.effect === 'worsened').length;
  const ranges = review.coverage.uncovered.length;
  const tail = [...annotated > annotationLimit ? [`Annotated on the diff: ${annotationLimit} of ${annotated}.`, ''] : [],
    ...ranges > annotationLimit ? [`Annotated on the diff: ${annotationLimit} of ${ranges} uncovered ranges.`, ''] : []];
  const { lines, cut } = issueTables(review, maxLength - [...head, ...tail].join('\n').length - 200);
  return [...head, ...lines, ...tail, ...cut ? [`${cut} more issues not shown.`, ''] : []].join('\n');
}

/**
 * One table per group, then the uncovered changed lines, with as many rows as the budget allows. Rows keep their order
 * of importance: once one doesn't fit, every later row is counted as cut.
 */
function issueTables(review: PullReview, budget: number): { lines: string[]; cut: number } {
  const tables = [...groups.map(({ effect, title, folded }) => ({ title, folded, heads: ['File', 'Issue'],
    rows: review.issues.filter(issue => issue.effect === effect).map(issue => `| ${place(issue.finding)} | ${describe(issue)} |`) })),
  { title: 'Changed lines without coverage', folded: true, heads: ['Changed lines'],
    rows: review.coverage.uncovered.map(({ path, first, last }) => `| ${location({ path, line: first, endLine: last })} |`) }];
  const lines: string[] = [];
  let left = budget;
  let cut = 0;
  for (const table of tables) {
    const rendered = cut ? { lines: [], length: 0, cut: table.rows.length } : fitTable(table, left);
    lines.push(...rendered.lines);
    left -= rendered.length;
    cut += rendered.cut;
  }
  return { lines, cut };
}

function fitTable({ title, folded, heads, rows }: { title: string; folded: boolean; heads: string[]; rows: string[] }, budget: number) {
  const header = [...folded ? [`<details><summary>${title} (${rows.length})</summary>`, ''] : [`### ${title}`, ''],
    `| ${heads.join(' | ')} |`, `| ${heads.map(() => '---').join(' | ')} |`];
  const closing = folded ? ['', '</details>', ''] : [''];
  const kept: string[] = [];
  let length = [...header, ...closing].join('\n').length + 1;
  for (const row of rows) {
    if (length + row.length + 1 > budget) break;
    length += row.length + 1;
    kept.push(row);
  }
  const cut = rows.length - kept.length;
  return kept.length ? { lines: [...header, ...kept, ...closing], length, cut } : { lines: [], length: 0, cut };
}

function headline({ verdict, issues, base, mergeBase, head, changedFiles }: PullReview): string {
  const counts = groups.map(({ effect }) => [effect, issues.filter(issue => issue.effect === effect).length] as const)
    .filter(([, count]) => count > 0).map(([effect, count]) => `${count} ${effect}`);
  const what = changedFiles === 0 ? `no changes since \`${base}\``
    : `${counts.length ? counts.join(' · ') : 'no issues'} on the lines changed since \`${base}\``;
  return `**${verdicts[verdict]}** · ${what} (\`${mergeBase.slice(0, 7)}\` → \`${head.slice(0, 7)}\`)`;
}

function facts({ coverage, debt, unmeasured, notes }: PullReview): string[] {
  const lines = [coverageLine(coverage)];
  if (debt.added || debt.removed) lines.push(`Debt: +${debt.added} min added, −${debt.removed} min removed`);
  lines.push(...few(unmeasured).map(reason => `Not measured: ${typeof reason === 'string' ? reason : reasonText(reason)}`));
  const unmapped = coverage.unmapped.map(({ path }) => code(path));
  if (unmapped.length) {
    const named = unmapped.length > 3 ? `${unmapped.slice(0, 3).join(', ')} and ${unmapped.length - 3} more` : unmapped.join(', ');
    lines.push(`Coverage has no record for ${unmapped.length} changed ${unmapped.length === 1 ? 'file' : 'files'}: ${named}`);
  }
  lines.push(...few(notes).map(reason => `Note: ${typeof reason === 'string' ? reason : reasonText(reason)}`));
  return lines;
}

/** The first reasons, and a count of the rest. */
function few(reasons: readonly ReviewReason[], shown = 5): (ReviewReason | string)[] {
  return reasons.length > shown ? [...reasons.slice(0, shown), `${reasons.length - shown} more`] : [...reasons];
}

function coverageLine({ imported, covered, total, percent, gate }: PullReview['coverage']): string {
  if (!imported) return 'Coverage not imported';
  const measured = percent === null ? 'no measured lines' : `${percent.toFixed(2)}% (${covered} of ${total} lines)`;
  if (gate === null) return `Changed-line coverage: ${measured}`;
  const status = gate.status === 'not-applicable' ? `applies from ${gate.minimumLines} measured lines` : gate.status;
  return `Changed-line coverage: ${measured}, minimum ${gate.minimumPercent}%, ${status}`;
}

function reasonText({ operation, path, message }: ReviewReason): string {
  return [operation, path === undefined ? undefined : `on ${code(path)}`].filter(Boolean).join(' ') + (operation || path ? ': ' : '')
    + cell(message);
}

function describe({ effect, finding, before, fixed, context }: ReviewedIssue): string {
  const parts = [clip(cell(finding.message))];
  if (fixed) parts.push('fixed');
  else if ((effect === 'worsened' || effect === 'improved') && before !== null) parts.push(`was ${before}`);
  if (context.length) parts.push(`same code as ${context.map(location).join(', ')}`);
  return parts.join(', ');
}

function place({ path, line, endLine }: { path?: string; line?: number; endLine?: number }): string {
  if (path === undefined) return '—';
  return line === undefined ? code(path) : location({ path, line, endLine: endLine ?? line });
}

function location({ path, line, endLine }: FindingLocation): string {
  return code(`${path}:${line}${endLine > line ? `–${endLine}` : ''}`);
}

function code(value: string): string {
  return `<code>${cell(value)}</code>`;
}

/** A long message is shortened, so one issue can't push the others out of the comment. */
function clip(value: string, length = 500): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function cell(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;')
    .replace(/[\r\n]+/g, ' ');
}
