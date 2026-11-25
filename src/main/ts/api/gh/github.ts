import { appendFile, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DiffCoverageReport } from '../../core/usecases/diff-coverage.js';
import { isRecord } from '../../core/engine/plugin.js';
import { annotationLimit } from '../../core/model/pull-review.js';
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

/** The number of the pull request whose event started this GitHub Actions run, if any. */
export async function gitHubPullRequest(): Promise<number | undefined> {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  const event: unknown = JSON.parse(await readFile(path, 'utf8'));
  const pull = isRecord(event) ? event.pull_request : undefined;
  const number = isRecord(pull) ? pull.number : undefined;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export async function writeGitHubReview(review: PullReview, markdown: string, repository: string): Promise<void> {
  const { output, summary } = githubFiles();
  const count = (effect: string) => review.issues.filter(issue => issue.effect === effect).length;
  await appendFile(output, [`verdict=${review.verdict}`, ...['new', 'worsened', 'improved', 'touched'].map(effect => `${effect}=${count(effect)}`),
    `changed-coverage=${review.coverage.percent ?? ''}`, ''].join('\n'));
  await appendFile(summary, markdown);
  const annotate = await annotator(repository);
  review.issues.filter(issue => issue.effect === 'new' || issue.effect === 'worsened').slice(0, annotationLimit)
    .forEach(({ effect, finding }) => annotate('error', `Repometry: ${effect} issue`, finding, finding.message));
  review.coverage.uncovered.slice(0, annotationLimit).forEach(({ path, first, last }) => annotate('warning', 'Repometry: not covered',
    { path, line: first, endLine: last }, `Changed lines ${first}${last > first ? `–${last}` : ''} are not covered`));
}

/** Writes workflow annotations for paths inside the checkout, relative to the workspace GitHub shows them in. */
async function annotator(repository: string) {
  const [workspace, root] = await Promise.all([realpath(process.env.GITHUB_WORKSPACE ?? process.cwd()), realpath(repository)]);
  const prefix = relative(workspace, root);
  const inside = !isAbsolute(prefix) && !prefix.split(sep).includes('..');
  return (kind: 'error' | 'warning', title: string, { path, line, endLine }: { path?: string; line?: number; endLine?: number },
    message: string): void => {
    if (!inside || path === undefined) return;
    const checkoutPath = relative(workspace, resolve(root, path));
    if (isAbsolute(checkoutPath) || checkoutPath.split(sep).includes('..')) return;
    const properties = [`file=${property(checkoutPath.split(sep).join('/'))}`,
      ...line === undefined ? [] : [`line=${line}`, `endLine=${endLine ?? line}`], `title=${property(title)}`];
    process.stderr.write(`::${kind} ${properties.join(',')}::${data(message)}\n`);
  };
}

function data(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function property(value: string): string {
  return data(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function githubFiles(): { output: string; summary: string } {
  const output = process.env.GITHUB_OUTPUT;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!output || !summary) throw new Error('GitHub reporting requires GITHUB_OUTPUT and GITHUB_STEP_SUMMARY');
  return { output, summary };
}
