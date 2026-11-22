import { isRecord } from '../../core/engine/plugin.js';

const marker = '<!-- repometry-coverage:v1 -->';
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const repositoryName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
type Environment = Record<string, string | undefined>;
type Outcome = 'skipped' | 'unchanged' | 'updated' | 'created';

export async function publishPullCoverageComment(env: Environment, request: typeof fetch = fetch): Promise<Outcome> {
  const { GITHUB_EVENT_NAME, GITHUB_REPOSITORY: repository, GITHUB_API_URL, REPOMETRY_COMMENT_TOKEN: token,
    REPOMETRY_PR_REPOSITORY, REPOMETRY_PR_NUMBER, REPOMETRY_PR_HEAD, REPOMETRY_PR_BASE,
    REPOMETRY_REVIEW_HEAD, REPOMETRY_REVIEW_BASE } = env;
  if (GITHUB_EVENT_NAME !== 'pull_request' || !repository || REPOMETRY_PR_REPOSITORY !== repository
    || REPOMETRY_REVIEW_HEAD !== REPOMETRY_PR_HEAD || REPOMETRY_REVIEW_BASE !== REPOMETRY_PR_BASE) return 'skipped';
  if (!repositoryName.test(repository) || repository.split('/').some(part => part === '.' || part === '..')
    || !sha.test(REPOMETRY_PR_HEAD ?? '') || !sha.test(REPOMETRY_PR_BASE ?? '')) return 'skipped';
  const number = count(REPOMETRY_PR_NUMBER);
  if (!number) return 'skipped';

  const body = coverageComment(env);
  if (body === null) return 'skipped';
  if (!GITHUB_API_URL || !token) throw new Error('Repometry PR comments require the GitHub Actions token and API URL');
  const api = new URL(GITHUB_API_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error('Invalid GitHub API URL');
  api.pathname = api.pathname.replace(/\/+$/, '') + '/';
  const prefix = `repos/${repository}`;
  const signal = AbortSignal.timeout(20_000);

  async function call(path: string, method = 'GET', content?: string): Promise<Response> {
    const response = await request(new URL(path, api), {
      method, signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: content === undefined ? undefined : JSON.stringify({ body: content }),
    });
    if (!response.ok) throw new Error(`GitHub PR comment request returned HTTP ${response.status}`);
    return response;
  }

  const pull: unknown = await (await call(`${prefix}/pulls/${number}`)).json();
  if (!isRecord(pull) || pull.state !== 'open' || !matchesRef(pull.head, REPOMETRY_PR_HEAD, repository)
    || !matchesRef(pull.base, REPOMETRY_PR_BASE, repository)) return 'skipped';

  const comments = `${prefix}/issues/${number}/comments`;
  for (let page = 1; page <= 100; page++) {
    const result: unknown = await (await call(`${comments}?per_page=100&page=${page}`)).json();
    if (!Array.isArray(result)) throw new Error('Invalid GitHub PR comments response');
    const owned = result.find(isOwnedComment);
    if (owned) {
      if (owned.body === body) return 'unchanged';
      await call(`${prefix}/issues/comments/${owned.id}`, 'PATCH', body);
      return 'updated';
    }
    if (result.length < 100) {
      await call(comments, 'POST', body);
      return 'created';
    }
  }
  throw new Error('Could not check all GitHub PR comments for the Repometry marker');
}

function matchesRef(ref: unknown, id: string | undefined, repository: string): boolean {
  return isRecord(ref) && ref.sha === id && isRecord(ref.repo) && ref.repo.full_name === repository;
}

function isOwnedComment(value: unknown): value is { id: number; body: string } {
  return isRecord(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0
    && typeof value.body === 'string' && value.body.startsWith(marker + '\n')
    && isRecord(value.user) && value.user.login === 'github-actions[bot]' && value.user.type === 'Bot';
}

function coverageComment(env: Environment): string | null {
  const total = decimal(env.REPOMETRY_TOTAL_PERCENT, 0, 100);
  const delta = decimal(env.REPOMETRY_TOTAL_DELTA, -100, 100);
  const diff = decimal(env.REPOMETRY_DIFF_PERCENT, 0, 100);
  const covered = count(env.REPOMETRY_DIFF_COVERED);
  const measured = count(env.REPOMETRY_DIFF_TOTAL);
  const status = env.REPOMETRY_DIFF_STATUS;
  if (total === null && diff === null && status !== 'partial' && status !== 'not-applicable') return null;

  const totalText = total === null ? 'Unavailable' : `${total.toFixed(2)}%`
    + (delta === null ? '' : ` (${delta > 0 ? '+' : ''}${delta.toFixed(2)} pp from base)`);
  const counts = covered !== null && measured !== null && covered <= measured && measured > 0 ? ` · ${covered}/${measured} measured lines` : '';
  const diffText = diff === null ? status === 'not-applicable' ? 'No measured changed lines' : 'Unavailable' : `${diff.toFixed(2)}%${counts}`;
  return [marker, '### Repometry coverage', '',
    '| Coverage | Result | Gate |', '| --- | --- | --- |',
    `| Total | ${totalText} | ${gate(env.REPOMETRY_TOTAL_GATE)} |`,
    `| Changed lines | ${diffText}${status === 'partial' ? ' · Partial' : ''} | ${gate(env.REPOMETRY_DIFF_GATE)} |`, '',
  ].join('\n');
}

function decimal(value: string | undefined, lower: number, upper: number): number | null {
  if (!value || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= lower && number <= upper ? number : null;
}

function count(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function gate(value: string | undefined): string {
  switch (value) {
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    case 'not-applicable': return 'Skipped';
    case 'indeterminate': return 'Incomplete';
    default: return '—';
  }
}
