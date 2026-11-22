import { appendFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DiffCoverageReport } from '../../core/usecases/diff-coverage.js';
import type { PullReview } from '../../core/model/pull-review.js';
import type { Report } from '../../core/model/report.js';

export async function writeGitHubResult(report: Report): Promise<void> {
  const { output, summary } = githubFiles();
  await appendFile(output, `subject=${report.subject.id}\nstatus=${report.status}\n`);
  await appendFile(summary, [
    '## Repometry', '',
    `**${report.status}** · \`${report.subject.id}\``, '',
    `Parsed ${report.scope.parsed} of ${report.scope.files} files.`,
    `Measurements: ${report.measurements.length}. Diagnostics: ${report.diagnostics.length}.`, '', '',
  ].join('\n'));
}

export async function writeGitHubDiffCoverage(report: DiffCoverageReport): Promise<void> {
  const { output, summary } = githubFiles();
  const decision = report.decision?.status ?? '';
  await appendFile(output, `status=${report.status}\npercent=${report.percent ?? ''}\ndecision=${decision}\n`);
  const observed = report.percent === null ? '—' : `${report.percent.toFixed(2)}%`;
  const policy = report.decision === null ? [] : [`Minimum ${report.decision.minimumPercent}% · **${report.decision.status}**`];
  await appendFile(summary, ['## Repometry diff coverage', '',
    `**${report.status}** · \`${report.base}\` → \`${report.head}\``, '',
    `Observed coverage ${observed} (${report.covered}/${report.total} reported lines). Gaps: ${report.gaps.length}.`,
    ...policy, '', '',
  ].join('\n'));
}

export async function writeGitHubReview(report: PullReview, repository?: string): Promise<void> {
  const { output, summary } = githubFiles();
  const { diff, coverage, findings } = report;
  await appendFile(output, [
    `status=${diff.status}`, `percent=${diff.percent ?? ''}`, `decision=${diff.gate?.status ?? ''}`,
    `review-base=${report.base}`, `review-head=${report.head}`, `diff-covered=${diff.covered}`, `diff-total=${diff.total}`,
    `coverage-percent=${coverage.head?.value ?? ''}`, `coverage-delta=${coverage.delta ?? ''}`,
    `coverage-decision=${coverage.gate?.status ?? ''}`,
    `new-issues=${findings.qualityCount ?? ''}`, `issues-decision=${findings.gate?.status ?? ''}`, '',
  ].join('\n'));
  const label = report.number === null ? 'Repometry review' : `Repometry review · PR #${report.number}`;
  const totals = [
    '| Check | Result | Gate |',
    '| --- | --- | --- |',
    `| Total coverage | ${percent(coverage.base?.value)} → ${percent(coverage.head?.value)} | ${coverage.gate ? `${coverage.gate.status}, max drop ${coverage.gate.maxDrop} pp` : '—'} |`,
    `| Changed-line coverage | ${percent(diff.percent)} (${diff.covered}/${diff.total}), ${diff.status} | ${diff.gate ? `${diff.gate.status}, min ${diff.gate.minimumPercent}% on ${diff.gate.minimumLines}+ lines` : '—'} |`,
    `| New quality issues | ${findings.qualityCount ?? 'Unavailable'} | ${findings.gate ? `${findings.gate.status}, max ${findings.gate.maximum}` : '—'} |`,
  ];
  const files = diff.files.slice(0, 50).map(file => {
    const result = file.covered === null || file.total === null ? '—' : `${file.covered}/${file.total}`;
    const missed = file.covered === null || file.total === null ? '—' : String(file.total - file.covered);
    return `| ${pathCode(file.path)} | ${file.addedLines} | ${result} | ${missed} |`;
  });
  const changes = files.length === 0 ? [] : ['', '### Changed files', '',
    '| File | Added lines | Covered / measured | Missed |',
    '| --- | ---: | ---: | ---: |', ...files,
    ...(diff.files.length > files.length ? ['', `Showing ${files.length} of ${diff.files.length} files.`] : [])];
  await appendFile(summary, [`## ${label}`, '', `\`${report.base}\` → \`${report.head}\``, '',
    ...totals, ...(diff.gaps.length ? ['', `Coverage gaps in ${diff.gaps.length} records.`] : []), ...changes, '', '',
  ].join('\n'));
  if (repository !== undefined && diff.uncovered.length > 0) await annotateUncovered(diff.uncovered, repository);
}

function percent(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(2)}%`;
}

function pathCode(value: string): string {
  const clean = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `<code>${clean}</code>`;
}

async function annotateUncovered(uncovered: PullReview['diff']['uncovered'], repository: string): Promise<void> {
  const [workspace, root] = await Promise.all([realpath(process.env.GITHUB_WORKSPACE ?? process.cwd()), realpath(repository)]);
  const prefix = relative(workspace, root);
  if (isAbsolute(prefix) || prefix.split(sep).includes('..')) return;
  let count = 0;
  for (const { path, lines } of uncovered) {
    const checkoutPath = relative(workspace, resolve(root, path));
    if (isAbsolute(checkoutPath) || checkoutPath.split(sep).includes('..')) continue;
    const file = checkoutPath.split(sep).join('/').replaceAll('%', '%25').replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A').replaceAll(':', '%3A').replaceAll(',', '%2C');
    for (const line of lines) {
      process.stderr.write(`::warning file=${file},line=${line},title=Repometry diff coverage::Changed line is not covered\n`);
      if (++count === 10) return;
    }
  }
}

function githubFiles(): { output: string; summary: string } {
  const output = process.env.GITHUB_OUTPUT;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!output || !summary) throw new Error('GitHub reporting requires GITHUB_OUTPUT and GITHUB_STEP_SUMMARY');
  return { output, summary };
}
