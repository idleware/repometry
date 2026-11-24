import type { InspectionAsset, InspectionDetails } from '../../json/wire/inspection-details-model.js';
import type { PublicHistoryEntry } from '../../json/wire/public-history-model.js';
import type { PullReview, PullReviews } from '../../json/wire/pull-review-model.js';
import { createCommitPicker } from './viewer-commit-picker.js';
import { loadViewerData, ViewerSummaryChanged } from './viewer-data.js';
import type { ViewerData } from './viewer-data.js';
import { byId, notice } from './viewer-dom.js';
import { renderFileView } from './viewer-files.js';
import { useCatalog } from './viewer-metrics.js';
import { renderInspection, renderQuality, renderScannerContext } from './viewer-overview-cards.js';
import { overviewStub, renderOverviewHotspots } from './viewer-overview-hotspots.js';
import { renderLead } from './viewer-overview-lead.js';
import { renderProfile } from './viewer-profile.js';
import { renderDiffCoverageTrend } from './viewer-pull-trend.js';
import { renderPulls } from './viewer-pulls.js';
import { href, isFilePage, needsDetails, readRoute } from './viewer-route.js';
import type { Page, Route } from './viewer-route.js';
import { firstArea, readOptional, renderTrend, showPage, showTab, showTitle, updateDetailsTabs, updateTabs, verdictTabs } from './viewer-shell.js';
import { loadSource, sourcePage, useSources } from './viewer-source.js';
import type { TrendData } from './viewer-trend-data.js';
import { renderTrendsPage } from './viewer-trends.js';

const mode = document.querySelector<HTMLMetaElement>('meta[name="repometry-view"]')?.content;
showTitle();

document.querySelector('.skip')?.addEventListener('click', (event) => {
  event.preventDefault();
  byId('main').focus();
});

const message = byId('message');
try {
  const data = await loadViewerData(mode);
  if (data.reports.length === 0) message.textContent = 'No commit inspections yet.';
  else start(data);
} catch {
  message.textContent = 'Could not load inspection history.';
}

function start(data: ViewerData): void {
  const { reports, quality, context, counts, pullReviewCount, branch, metrics, sources, loadDetails } = data;
  useCatalog(metrics);
  useSources(sources);
  const commits = new Set(reports.map(report => report.sha));
  const bySha = new Map(reports.map(report => [report.sha, report]));
  const cached = new Map<string, InspectionDetails>();
  const pending = new Map<string, Promise<InspectionAsset | null>>();
  const compact = window.matchMedia('(max-width: 43rem)');
  const history = { quality, context };
  let pulls: Promise<readonly PullReview[] | null> | undefined;
  let revision = 0;
  let chartMetric = firstArea(data);
  const route = () => readRoute(location.hash, commits, reports[0]!.sha);

  function selectedDetails(sha: string): Promise<InspectionAsset | null> {
    const existing = pending.get(sha);
    if (existing) return existing;
    const request = loadDetails(sha).catch(error => {
      if (error instanceof ViewerSummaryChanged && route().sha === sha) location.reload();
      return null;
    }).then(asset => {
      if (!asset) pending.delete(sha);
      else remember(sha, asset);
      return asset;
    });
    pending.set(sha, request);
    return request;
  }

  function remember(sha: string, asset: InspectionAsset): void {
    cached.set(sha, asset.inspection);
    if (asset.context) context[sha] = { ...asset.context, boundary: context[sha]?.boundary ?? asset.context.boundary };
  }

  const commit = createCommitPicker(byId('commit-control'), reports, sha => {
    const { page, view, period } = route();
    location.hash = href({ page, sha, view, period });
  }, branch);
  const markVerdict = verdictTabs(metric => {
    chartMetric = metric;
    const { sha } = route();
    renderTrend(trendData(), bySha.get(sha)!, chartMetric, compact.matches);
    renderLead(reports, bySha.get(sha)!, history, chartMetric, cached.get(sha));
    const details = cached.get(sha);
    if (details) renderOverviewHotspots(details, sha, chartMetric, context[sha]?.security !== undefined);
  });
  markVerdict(chartMetric);
  byId('inspection-meta').hidden = false;
  commit.hidden = false;
  for (const item of document.querySelectorAll<HTMLElement>('[data-loaded]')) item.hidden = false;

  function loadPulls(): Promise<readonly PullReview[] | null> {
    pulls ??= readOptional<PullReviews>('./pulls.json').then(bundle =>
      bundle?.schema === 'urn:repometry:schema:pull-reviews:1' ? bundle.reviews : null);
    return pulls;
  }

  function trendData(): TrendData {
    return {
      reports, quality, context, compact: compact.matches, reviews: pullReviewCount,
      link: (sha, view, period) => href({ page: 'trends', sha, view, period }),
    };
  }

  function refreshTabs(page: Page, sha: string, version: number, detail: Promise<InspectionAsset | null> | undefined): void {
    const row = counts[sha];
    const cachedDetail = cached.get(sha);
    if (row) updateTabs(page, row.findingCount, row.diagnosticCount);
    else if (cachedDetail) updateDetailsTabs(page, cachedDetail);
    if (pullReviewCount !== undefined) showTab('pulls', pullReviewCount > 0 || page === 'pulls');
    else void loadPulls().then(records => {
      if (version === revision) showTab('pulls', Boolean(records?.length) || page === 'pulls');
    });
    void detail?.then(asset => {
      if (!asset || version !== revision) return;
      updateDetailsTabs(page, asset.inspection);
      renderScannerContext(context[sha], sha);
    });
  }

  /** Pull request reviews load once, on the first page that needs them. */
  function withPulls(target: HTMLElement, version: number, show: (records: readonly PullReview[] | null) => void): void {
    notice(target, 'Loading saved pull request reviews…');
    void loadPulls().then(records => {
      if (version === revision) show(records);
    });
  }

  function showTrends(current: Route, report: PublicHistoryEntry, version: number): void {
    const slot = renderTrendsPage(byId('trends-content'), trendData(), report, current.view, current.period);
    if (!slot) return;
    withPulls(slot, version, records => {
      if (records?.length) renderDiffCoverageTrend(slot, records);
      else notice(slot, 'No saved pull request reviews yet.');
    });
  }

  function showPulls(version: number): void {
    const target = byId('pulls');
    withPulls(target, version, records => {
      if (records) renderPulls(target, records);
      else notice(target, 'Could not load saved pull request reviews.');
    });
  }

  /** The profile draws at once from the summary, and again with the details: exclusions, rules and ignores. */
  function showSettings(report: PublicHistoryEntry, version: number, detail: Promise<InspectionAsset | null> | undefined): void {
    const newest = reports[0]!;
    const draw = (details?: InspectionDetails) => renderProfile(byId('settings-content'), {
      report, context: context[report.sha], details,
      latest: { report: newest, quality: quality[newest.sha], context: context[newest.sha] },
    });
    draw(cached.get(report.sha));
    if (!cached.has(report.sha)) void detail?.then(asset => {
      if (asset && version === revision) draw(asset.inspection);
    });
  }

  /** The Overview's hotspots, or a page that reads one inspection, drawn once its details are here. */
  function showDetails(current: Route, report: PublicHistoryEntry, version: number, detail: Promise<InspectionAsset | null> | undefined): void {
    const page = current.page;
    const target = byId(page === 'overview' ? 'overview-hotspot-list' : `${page}-content`);
    const display = (details: InspectionDetails) => {
      if (isFilePage(page)) {
        renderFileView(target, page, details, {
          directory: current.directory ?? '', file: current.file ?? '', query: current.query, group: current.group, line: current.line,
          category: current.category, level: current.level, rank: current.rank, layer: current.layer,
          source: path => loadSource(report.sha, path),
          sourcePage: (path, line) => sourcePage(report.sha, path, line),
          href: (destination, options) => href({ page: destination, sha: report.sha, ...options }),
        });
        return;
      }
      // The details name the most complex function, so its figure can now lead to its line.
      renderLead(reports, report, history, chartMetric, details);
      renderOverviewHotspots(details, report.sha, chartMetric, context[report.sha]?.security !== undefined);
    };
    const existing = cached.get(report.sha);
    if (existing) {
      display(existing);
      return;
    }
    if (page === 'overview') overviewStub(report.sha);
    else notice(target, 'Loading inspection details…');
    void detail?.then(asset => {
      if (version !== revision) return;
      if (asset) display(asset.inspection);
      else notice(target, 'Could not load inspection details.');
    });
  }

  function render(): void {
    const current = route();
    const version = ++revision;
    const report = bySha.get(current.sha)!;
    const { page } = current;
    commit.set(report.sha);
    commit.hidden = page === 'pulls';
    showPage(current);
    renderInspection(report);
    renderQuality(report, quality[report.sha]);
    if (page === 'overview') renderLead(reports, report, history, chartMetric, cached.get(report.sha));
    renderScannerContext(context?.[current.sha], report.sha);
    const detail = needsDetails(page) ? selectedDetails(report.sha) : undefined;
    refreshTabs(page, report.sha, version, detail);
    if (page === 'overview') renderTrend(trendData(), report, chartMetric, compact.matches);
    if (page === 'trends') showTrends(current, report, version);
    else if (page === 'pulls') showPulls(version);
    else if (page === 'settings') showSettings(report, version, detail);
    else showDetails(current, report, version, detail);
  }

  window.addEventListener('hashchange', render);
  compact.addEventListener('change', render);
  message.hidden = true;
  render();
}
