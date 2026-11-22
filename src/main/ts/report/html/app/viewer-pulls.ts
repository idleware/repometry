import type { PullReview } from '../../json/wire/pull-review-model.js';

const whole = new Intl.NumberFormat();
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const points = new Intl.NumberFormat(undefined, { signDisplay: 'exceptZero', maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const coverageReasons = {
  'reports-unavailable': 'Save inspections for the base and head commits to compare total coverage.',
  'observations-unavailable': 'The saved inspections lack complete line coverage data.',
  'source-scope-unknown': 'The inspected source scope is unavailable for one of the revisions.',
  'source-scope-changed': 'The base and head used different source scopes.',
  'method-unknown': 'The coverage method is unavailable for one of the revisions.',
  'method-changed': 'The base and head used different coverage methods.',
  'head-coverage-changed': 'The review used a different LCOV input than the saved head inspection.',
};
const findingReasons = {
  'reports-unavailable': 'Save inspections for the base and head commits to compare findings.',
  'findings-unavailable': 'One or both revisions lack findings data.',
  'partial-inspection': 'One or both revisions have incomplete analysis.',
  'analysis-changed': 'The base and head used different analysis settings.',
};

export function renderPulls(container: HTMLElement, records: readonly PullReview[]): void {
  const heading = node('h2', 'Pull requests');
  // The page title stands outside the card, as on every other page; the review picker shares its row.
  const toolbar = node('div', '', 'section-heading pull-heading');
  toolbar.append(heading);
  const selection = node('section', '', 'panel');
  container.replaceChildren(toolbar, selection);
  if (records.length === 0) {
    selection.append(node('p', 'No saved PR reviews. Run Repometry on a pull request with its base revision and PR number.', 'detail empty'));
    return;
  }
  const view = node('div');
  selection.append(view);
  const display = (review: PullReview) => view.replaceChildren(reviewSummary(review), reviewFiles(review), reviewIssues(review));
  display(records[0]!);
  if (records.length === 1) {
    const number = records[0]!.number;
    if (number !== null) heading.append(node('span', ` #${number}`, 'pull-number'));
    return;
  }
  const label = node('label', 'Saved review', 'pull-picker');
  const select = node('select');
  for (const [index, review] of records.entries()) {
    select.append(new Option(`#${review.number} · ${review.head.slice(0, 7)}`, String(index)));
  }
  label.append(select);
  toolbar.append(label);
  select.addEventListener('change', () => {
    const review = records[select.selectedIndex];
    if (review) display(review);
  });
}

export function renderDiffCoverageTrend(container: HTMLElement, records: readonly PullReview[]): void {
  const heading = node('h2', 'Changed-line coverage by pull request');
  container.replaceChildren(heading);
  const reviews = [...records].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt)).slice(0, 12);
  if (reviews.length === 0) {
    container.append(node('p', 'No saved PR reviews.', 'detail'));
    return;
  }

  const list = node('ol', '', 'pull-trend-list');
  const axis = node('div', '', 'pull-trend-axis');
  axis.setAttribute('aria-hidden', 'true');
  for (const value of [0, 25, 50, 75, 100]) axis.append(node('span', `${value}%`));
  container.append(axis, list);
  for (const review of reviews) {
    const row = node('li', '', 'pull-trend-row');
    const label = review.number === null ? review.head.slice(0, 7) : `#${review.number}`;
    const subject = node('div', '', 'pull-trend-subject');
    const time = node('time', date.format(new Date(review.generatedAt)), 'detail');
    time.dateTime = review.generatedAt;
    subject.append(node('strong', label), time);

    const track = node('div', '', 'pull-trend-track');
    track.setAttribute('aria-hidden', 'true');
    const { percent, status, covered, total } = review.diff;
    if (percent !== null) {
      const bar = node('div', '', 'pull-trend-bar');
      bar.dataset.status = status;
      bar.style.inlineSize = `${percent}%`;
      track.append(bar);
    }

    const value = node('div', '', 'pull-trend-result');
    if (percent === null) {
      value.append(node('span', status === 'partial' ? 'Partial · Unmeasured'
        : status === 'not-applicable' ? 'No measurable changes' : 'Coverage unavailable', 'detail'));
      track.classList.add('pull-trend-empty');
    } else {
      const result = `${whole.format(covered)} / ${whole.format(total)} lines`;
      value.append(node('strong', formatPercent(percent)),
        node('span', status === 'partial' ? `Partial · ${result}` : result, 'detail'));
    }
    row.append(subject, track, value);
    list.append(row);
  }
}

function reviewSummary({ base, head, coverage, diff, findings }: PullReview): HTMLElement {
  const header = node('div', '', 'pull-revisions');
  header.append(node('p', 'Base ', 'detail'), node('code', base.slice(0, 7)),
    node('span', '→', 'detail'), node('p', 'Head ', 'detail'), node('code', head.slice(0, 7)));

  const summary = node('div', '', 'pull-summary');
  const total = coverage.head?.value == null ? 'Unavailable' : formatPercent(coverage.head.value);
  const change = coverage.delta === null ? 'No comparable base coverage' : `${points.format(coverage.delta)} pp from base`;
  summary.append(summaryMetric('Total coverage', total, change, coverage.gate?.status),
    summaryMetric('Changed-line coverage', formatPercent(diff.percent), diff.percent === null
      ? diff.status === 'not-applicable' ? 'No measured changed lines' : 'Coverage unavailable'
      : `${whole.format(diff.covered)} of ${whole.format(diff.total)} measured lines${diff.status === 'partial' ? ' · Partial' : ''}`, diff.gate?.status),
    summaryMetric('New issues', findings.added === null ? 'Unavailable' : whole.format(findings.added.length),
      findings.gate && findings.qualityCount !== null && findings.qualityCount !== findings.added?.length
        ? `Gate counted ${whole.format(findings.qualityCount)} quality issues`
        : findings.added === null ? '' : 'Compared with base', findings.gate?.status));

  const result = node('div', '', 'pull-summary-block');
  result.append(header, summary);
  if (coverage.reason && (coverage.base || coverage.head || coverage.gate)) result.append(node('p', coverageReasons[coverage.reason], 'detail'));
  return result;
}

function summaryMetric(label: string, value: string, detail: string, gate: string | undefined): HTMLElement {
  const figure = node('div', '', 'pull-fact');
  figure.append(node('span', label, 'detail'), node('strong', value, 'pull-value'));
  if (detail) figure.append(node('p', detail, 'detail'));
  if (gate) {
    const badge = node('span', {
      passed: 'Gate passed', failed: 'Gate failed', 'not-applicable': 'Gate skipped', indeterminate: 'Gate pending data',
    }[gate] ?? gate, 'status pull-gate');
    badge.dataset.status = gate === 'passed' ? 'complete' : gate === 'indeterminate' ? 'partial' : gate;
    figure.append(badge);
  }
  return figure;
}

function reviewFiles(review: PullReview): HTMLElement {
  const section = node('section', '', 'pull-section');
  const heading = node('h3', 'Changed files');
  section.append(heading);
  const { diff } = review;
  if (diff.excludedPaths?.length) {
    section.append(node('p', `Path exclusions · ${diff.excludedPaths.join(', ')}`, 'detail pull-exclusions'));
  }
  if (diff.files.length === 0 && diff.gaps.length === 0) {
    section.append(node('p', diff.status === 'unavailable' ? 'Provide LCOV for this head revision to inspect its changed lines.'
      : 'No added or modified source lines in the inspected scope.', 'detail'));
    return section;
  }
  const files = new Map(diff.uncovered.map(file => [file.path, file.lines]));
  const gaps = new Map(diff.gaps.map(gap => [gap.path, gap.reason]));
  const rows = [...diff.files].sort((left, right) => missedCount(right) - missedCount(left) || right.addedLines - left.addedLines)
    .map(record => {
      const { path, addedLines, covered, total } = record;
      const label = node('th');
      const parts = path.split('/');
      for (const [index, part] of parts.entries()) {
        label.append(part);
        if (index < parts.length - 1) label.append('/', node('wbr'));
      }
      label.scope = 'row';
      const missing = files.get(path);
      const gap = gaps.get(path);
      gaps.delete(path);
      if (missing) {
        const details = node('details', '', 'pull-missed-lines');
        const ranges = lineRanges(missing);
        details.append(node('summary', `${whole.format(missing.length)} missed ${missing.length === 1 ? 'line' : 'lines'}`),
          node('span', ranges.join(', ')));
        label.append(details);
      }
      if (gap) label.append(node('p', gap, 'detail'));
      const row = node('tr');
      row.append(label, cell(whole.format(addedLines), true), cell(covered === null || total === null ? '—' : `${whole.format(covered)} / ${whole.format(total)}`, true));
      return row;
    });
  if (rows.length > 0) section.append(table('Changed file coverage', ['File', 'Added lines', 'Covered / measured'], rows, 'pull-coverage-table'));
  if (gaps.size > 0) {
    const notes = node('ul', '', 'pull-gaps');
    for (const [path, reason] of gaps) notes.append(node('li', `${path} · ${reason}`));
    section.append(node('h4', 'Coverage gaps'), notes);
  }
  return section;
}

function reviewIssues({ findings }: PullReview): HTMLElement {
  const section = node('section', '', 'pull-section');
  section.append(node('h3', 'New issues'));
  if (findings.added === null || findings.added.length === 0) {
    section.append(node('p', findings.reason ? findingReasons[findings.reason] : 'No new issues in the inspected scope.', 'detail'));
    return section;
  }
  const rows = findings.added.map(finding => {
    const row = node('tr');
    const message = node('th', finding.message);
    message.scope = 'row';
    message.append(node('p', [finding.tool, finding.rule].join(' · '), 'detail'));
    const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : '—';
    row.append(message, cell(location), cell(finding.level));
    return row;
  });
  section.append(table('Newly introduced findings', ['Finding', 'Source', 'Severity'], rows));
  return section;
}

function lineRanges(lines: readonly number[]): string[] {
  const ranges: string[] = [];
  for (let start = 0; start < lines.length;) {
    let end = start;
    while (lines[end + 1] === lines[end]! + 1) end++;
    ranges.push(start === end ? String(lines[start]) : `${lines[start]}–${lines[end]}`);
    start = end + 1;
  }
  return ranges;
}

function missedCount({ covered, total }: PullReview['diff']['files'][number]): number {
  return covered === null || total === null ? -1 : total - covered;
}

function formatPercent(value: number | null): string {
  return value === null ? 'Unavailable' : percentage.format(value / 100);
}

function table(label: string, headers: readonly string[], rows: readonly HTMLTableRowElement[], className = ''): HTMLElement {
  const table = node('table', '', `pull-table ${className}`.trim());
  const thead = node('thead');
  const headings = node('tr');
  for (const text of headers) {
    const th = node('th', text);
    th.scope = 'col';
    headings.append(th);
  }
  thead.append(headings);
  const body = node('tbody');
  body.append(...rows);
  table.append(thead, body);
  table.setAttribute('aria-label', label);
  return table;
}

function cell(text: string, numeric = false): HTMLTableCellElement {
  return node('td', text, numeric ? 'numeric' : '');
}

function node<K extends keyof HTMLElementTagNameMap>(name: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(name);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
