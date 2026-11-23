import { loadViewerData, ViewerSummaryChanged } from './viewer-data.js';
import { band, bandLimits, codeSmellCategories, renderFileView, mapStub, renderSunburst, securityCategories } from './viewer-files.js';
import { count, difference, formatMetric, labelOf, metricValue, pluginSpec, securityGrades, securityRisks, useCatalog } from './viewer-metrics.js';
import { charted, commitTime, isPeriod, stableWindow, isTrendView, renderSeries, renderTrendsPage, seriesPoints, trendLegend } from './viewer-trends.js';
import { createCommitPicker } from './viewer-commits.js';
import { renderProfile } from './viewer-profile.js';
import { loadSource, sourcePage, useSources } from './viewer-source.js';
import { renderDiffCoverageTrend, renderPulls } from './viewer-pulls.js';
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/**
 * Each quality area brings its own figures under the chart, and a second series drawn in grey behind the first:
 * maintainability pairs the debt ratio with the remediation time, coverage pairs the ratio with the uncovered lines.
 */
const areas = {
    debt: { figures: ['debt', 'effort', 'duplication', 'complexity'] },
    coverage: { figures: ['coverage', 'coverable-lines', 'covered-lines', 'uncovered-lines'] },
    security: { figures: ['security', 'security-high', 'security-medium', 'security-low'] },
    complexity: { figures: ['complexity', 'functions', 'cognitive', 'code-lines'] },
};
/** Coverage kinds beyond lines, by their registry keys, in the words the Overview card uses for them. */
const coverageKinds = [['branch-coverage', 'Branches'], ['function-coverage', 'Functions']];
const pages = ['overview', 'metrics', 'hotspots', 'trends', 'issues', 'diagnostics', 'settings', 'pulls'];
const mode = document.querySelector('meta[name="repometry-view"]')?.content;
const title = document.querySelector('meta[name="repometry-project"]')?.content.trim();
if (title) {
    document.title = `${title} · Repometry`;
    element('project-name').textContent = title;
}
document.querySelector('.skip')?.addEventListener('click', (event) => {
    event.preventDefault();
    element('main').focus();
});
const message = element('message');
try {
    const data = await loadViewerData(mode);
    if (data.reports.length === 0)
        message.textContent = 'No commit inspections yet.';
    else
        start(data);
}
catch {
    message.textContent = 'Could not load inspection history.';
}
function start({ reports, quality, context, counts, pullReviewCount, branch, metrics, sources, loadDetails }) {
    useCatalog(metrics);
    useSources(sources);
    const first = reports[0];
    const bySha = new Map(reports.map(report => [report.sha, report]));
    const cached = new Map();
    const pending = new Map();
    function selectedDetails(sha) {
        const existing = pending.get(sha);
        if (existing)
            return existing;
        const request = loadDetails(sha).catch(error => {
            if (error instanceof ViewerSummaryChanged && route().sha === sha)
                location.reload();
            return null;
        }).then(asset => {
            if (asset) {
                cached.set(sha, asset.inspection);
                if (asset.context)
                    context[sha] = { ...asset.context, boundary: context[sha]?.boundary ?? asset.context.boundary };
            }
            else
                pending.delete(sha);
            return asset;
        });
        pending.set(sha, request);
        return request;
    }
    const verdicts = document.querySelectorAll('.verdict-tab');
    const compact = window.matchMedia('(max-width: 43rem)');
    const navLinks = document.querySelectorAll('#navigation a');
    let pulls;
    let revision = 0;
    const commit = createCommitPicker(element('commit-control'), reports, sha => {
        const { page, view, period } = route();
        location.hash = href({ page, sha, view, period });
    }, branch);
    let chartMetric = reports.some(report => quality[report.sha]?.maintainability?.debtRatio != null) ? 'debt'
        : reports.some(report => report.lineCoverage !== null) ? 'coverage' : 'complexity';
    function selectVerdict() {
        for (const verdict of verdicts) {
            const selected = verdict.dataset.metric === chartMetric;
            verdict.setAttribute('aria-selected', String(selected));
            verdict.tabIndex = selected || (!verdicts.length) ? 0 : -1;
        }
    }
    for (const verdict of verdicts) {
        verdict.addEventListener('click', () => {
            chartMetric = verdict.dataset.metric;
            selectVerdict();
            const { sha } = route();
            renderTrend(trendData(), bySha.get(sha), chartMetric, compact.matches);
            renderLead(reports, bySha.get(sha), quality, context, chartMetric, cached.get(sha));
            const details = cached.get(sha);
            if (details)
                renderOverviewHotspots(details, sha, chartMetric, context[sha]?.security !== undefined);
        });
        verdict.addEventListener('keydown', event => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
                return;
            const visible = [...verdicts].filter(item => !item.closest('.verdict').hidden);
            const next = visible[(visible.indexOf(verdict) + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
            next.focus();
            next.click();
        });
    }
    selectVerdict();
    element('inspection-meta').hidden = false;
    commit.hidden = false;
    for (const item of document.querySelectorAll('[data-loaded]'))
        item.hidden = false;
    function route() {
        const [rawPage = '', query = ''] = location.hash.slice(1).split('?', 2);
        if (bySha.has(rawPage))
            return { page: 'overview', sha: rawPage };
        const params = new URLSearchParams(query);
        // Components became a grouping of Metrics; old links land there.
        if (rawPage === 'components')
            return { page: 'metrics', sha: bySha.get(params.get('sha') ?? '')?.sha ?? first.sha, group: 'components' };
        const page = pages.find(candidate => candidate === rawPage);
        return {
            page: page ?? 'overview',
            sha: bySha.get(params.get('sha') ?? '')?.sha ?? first.sha,
            directory: params.get('dir') ?? undefined,
            file: params.get('file') ?? undefined,
            view: isTrendView(params.get('view')) ? params.get('view') : undefined,
            period: isPeriod(params.get('period')) ? params.get('period') : undefined,
            query: params.get('q') ?? undefined,
            group: params.get('group') ?? undefined,
            line: Number(params.get('line')) > 0 ? Number(params.get('line')) : undefined,
            category: params.get('category') ?? undefined,
            level: params.get('level') ?? undefined,
            rank: params.get('rank') ?? undefined,
        };
    }
    function loadPulls() {
        pulls ??= readOptional('./pulls.json').then(bundle => bundle?.schema === 'urn:repometry:schema:pull-reviews:1' ? bundle.reviews : null);
        return pulls;
    }
    function render() {
        const current = route();
        const version = ++revision;
        const report = bySha.get(current.sha);
        const inspection = context?.[current.sha];
        const previousPage = pages.find(page => !element(page).hidden);
        const focusWasInPage = previousPage && element(previousPage).contains(document.activeElement);
        commit.set(report.sha);
        commit.hidden = current.page === 'pulls';
        element('inspection-meta').hidden = current.page === 'pulls';
        for (const page of pages)
            element(page).hidden = page !== current.page;
        if (previousPage && previousPage !== current.page) {
            window.scrollTo({ top: 0 });
            if (focusWasInPage) {
                const section = element(current.page);
                section.tabIndex = -1;
                section.focus({ preventScroll: true });
            }
        }
        for (const link of navLinks) {
            const page = link.dataset.page;
            link.href = href({ page, sha: current.sha });
            if (page === current.page)
                link.setAttribute('aria-current', 'page');
            else
                link.removeAttribute('aria-current');
        }
        document.querySelector('.brand').href = href({ page: 'overview', sha: current.sha });
        renderInspection(report);
        renderQuality(report, quality[report.sha]);
        if (current.page === 'overview')
            renderLead(reports, report, quality, context, chartMetric, cached.get(report.sha));
        renderScannerContext(inspection, report.sha);
        const needsDetail = isFilePage(current.page) || ['overview', 'settings'].includes(current.page) || !counts;
        const detail = needsDetail ? selectedDetails(report.sha) : undefined;
        const row = counts?.[report.sha];
        const cachedDetail = cached.get(report.sha);
        if (row)
            updateTabs(current.page, row.findingCount, row.diagnosticCount, row.componentCount);
        else if (cachedDetail)
            updateDetailsTabs(current.page, cachedDetail);
        if (pullReviewCount !== undefined)
            showTab('pulls', pullReviewCount > 0 || current.page === 'pulls');
        else
            void loadPulls().then(records => {
                if (version === revision)
                    showTab('pulls', Boolean(records?.length) || current.page === 'pulls');
            });
        void detail?.then(asset => {
            if (!asset || version !== revision)
                return;
            updateDetailsTabs(current.page, asset.inspection);
            const latest = context[report.sha];
            renderScannerContext(latest, report.sha);
        });
        if (current.page === 'overview')
            renderTrend(trendData(), report, chartMetric, compact.matches);
        if (current.page === 'trends') {
            const slot = renderTrendsPage(element('trends-content'), trendData(), report, current.view, current.period);
            if (slot) {
                notice(slot, 'Loading saved pull request reviews…');
                void loadPulls().then(records => {
                    if (version !== revision)
                        return;
                    if (records?.length)
                        renderDiffCoverageTrend(slot, records);
                    else
                        notice(slot, 'No saved pull request reviews yet.');
                });
            }
        }
        const page = current.page;
        if (page === 'pulls') {
            const target = element('pulls');
            notice(target, 'Loading saved pull request reviews…');
            void loadPulls().then(records => {
                if (version !== revision)
                    return;
                if (records)
                    renderPulls(target, records);
                else
                    notice(target, 'Could not load saved pull request reviews.');
            });
            return;
        }
        if (page === 'settings') {
            // The profile draws at once from the summary, and again with the details: exclusions, rules and ignores.
            const newest = reports[0];
            const draw = (details) => renderProfile(element('settings-content'), {
                report, context: context[report.sha], details,
                latest: { report: newest, quality: quality[newest.sha], context: context[newest.sha] },
            });
            draw(cached.get(report.sha));
            if (!cached.has(report.sha))
                void detail?.then(asset => {
                    if (asset && version === revision)
                        draw(asset.inspection);
                });
            return;
        }
        if (!isFilePage(page) && page !== 'overview')
            return;
        const target = element(page === 'overview' ? 'overview-hotspot-list' : `${page}-content`);
        function display(details) {
            if (page === 'overview') {
                // The details name the most complex function, so its figure can now lead to its line.
                renderLead(reports, report, quality, context, chartMetric, details);
                renderOverviewHotspots(details, report.sha, chartMetric, context[report.sha]?.security !== undefined);
            }
            else if (isFilePage(page)) {
                renderFileView(target, page, details, {
                    directory: current.directory ?? '',
                    file: current.file ?? '',
                    query: current.query,
                    group: current.group,
                    line: current.line,
                    category: current.category,
                    level: current.level,
                    rank: current.rank,
                    source: path => loadSource(report.sha, path),
                    sourcePage: (path, line) => sourcePage(report.sha, path, line),
                    href: (destination, options) => href({ page: destination, sha: report.sha, ...options }),
                });
            }
        }
        const existing = cached.get(report.sha);
        if (existing)
            display(existing);
        else {
            if (page === 'overview')
                overviewStub(report.sha);
            else
                notice(target, 'Loading inspection details…');
            void detail?.then(asset => {
                if (version !== revision)
                    return;
                if (asset)
                    display(asset.inspection);
                else
                    notice(target, 'Could not load inspection details.');
            });
        }
    }
    function showTab(page, visible) {
        const tab = document.querySelector(`#navigation a[data-page="${page}"]`);
        if (tab)
            tab.hidden = !visible;
    }
    /** Tabs follow the code: pages with nothing to show leave the bar, and issues and diagnostics carry their count. */
    function updateDetailsTabs(page, details) {
        updateTabs(page, details.findings?.length ?? 0, details.diagnostics.length, details.components?.length ?? 0);
    }
    function updateTabs(page, findings, diagnostics, components) {
        element('issues-count').textContent = count(findings);
        element('diagnostics-count').textContent = count(diagnostics);
        showTab('diagnostics', diagnostics > 0 || page === 'diagnostics');
    }
    function trendData() {
        return {
            reports, quality, context, compact: compact.matches,
            link: (sha, view, period) => href({ page: 'trends', sha, view, period }),
        };
    }
    window.addEventListener('hashchange', render);
    compact.addEventListener('change', render);
    message.hidden = true;
    render();
}
function href({ page, sha, directory, file, view, period, query, group, line, category, level, rank }) {
    const params = new URLSearchParams({ sha });
    if (directory)
        params.set('dir', directory);
    if (file)
        params.set('file', file);
    if (view)
        params.set('view', view);
    if (period)
        params.set('period', period);
    if (query)
        params.set('q', query);
    if (group)
        params.set('group', group);
    if (line)
        params.set('line', String(line));
    if (category)
        params.set('category', category);
    if (level)
        params.set('level', level);
    if (rank)
        params.set('rank', rank);
    // Category lists read as written: category=structure,duplication.
    return `#${page}?${params.toString().replaceAll('%2C', ',')}`;
}
function isFilePage(page) {
    return page === 'metrics' || page === 'hotspots' || page === 'issues' || page === 'diagnostics';
}
/** A detail that counts something leads to exactly what it counts, where the report has a page for it. */
function detailText(id, text, link) {
    if (link === undefined) {
        element(id).textContent = text;
        return;
    }
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.textContent = text;
    element(id).replaceChildren(anchor);
}
/** Where each Overview figure leads: the findings it counts, the files it ranks, the function it names. */
function smellsLink(sha) {
    return href({ page: 'issues', sha, category: codeSmellCategories.join(',') });
}
function securityLink(sha, level) {
    return href({ page: 'issues', sha, category: securityCategories.join(','), ...level ? { level } : {} });
}
function uncoveredLink(sha) {
    return href({ page: 'hotspots', sha, rank: 'missedLines' });
}
function renderInspection(report) {
    const coverage = report.lineCoverage && report.lineCoverage.total > 0 ? report.lineCoverage.covered / report.lineCoverage.total : null;
    if (coverage === null)
        detailText('coverage-detail', 'No coverage report');
    else
        detailText('coverage-detail', `${coverageText(report.lineCoverage)} of ${count(report.lineCoverage.total)} lines`, coverage < 1 ? uncoveredLink(report.sha) : undefined);
    element('coverage-mark').replaceChildren(ring(coverage));
    // Line coverage leads; the other kinds the coverage report carries follow on a quieter line.
    const kinds = coverageKinds.flatMap(([key, name]) => {
        const metric = key;
        const value = pluginSpec(metric) ? metricValue(report, metric, undefined) : null;
        if (value === null)
            return [];
        // Each kind keeps its number; a narrow card wraps between kinds, never inside one.
        const kind = document.createElement('span');
        kind.textContent = `${name} ${formatMetric(value, metric)}`;
        return [kind];
    });
    element('coverage-kinds').replaceChildren(...kinds.flatMap((kind, index) => index ? [' · ', kind] : [kind]));
    element('coverage-kinds').hidden = kinds.length === 0;
}
function renderQuality(report, quality) {
    const maintainability = quality?.maintainability ?? null;
    const grade = element('maintainability');
    grade.textContent = maintainability?.grade ?? '–';
    grade.dataset.grade = maintainability?.grade ?? 'none';
    if (!maintainability)
        detailText('maintainability-detail', 'Not measured');
    else
        detailText('maintainability-detail', quantity(maintainability.smells, 'code smell'), maintainability.smells > 0 ? smellsLink(report.sha) : undefined);
}
function quantity(amount, noun) {
    return `${count(amount)} ${amount === 1 ? noun : `${noun}s`}`;
}
function renderLead(reports, selected, quality, context, area, details) {
    const index = reports.indexOf(selected);
    const previous = reports[index + 1];
    const comparable = previous !== undefined;
    // A figure shows its change only when it moved; what it is measured from is in the change's tooltip.
    const time = previous ? commitTime(previous) : null;
    const inspectedAt = Date.parse(previous?.generatedAt ?? '');
    const before = time !== null ? `the commit of ${dateTime.format(time)}` : Number.isFinite(inspectedAt)
        ? `the inspection of ${dateTime.format(inspectedAt)}` : 'the previous inspection';
    const profileChanged = context?.[selected.sha]?.boundary === 'changed';
    const figures = (areas[area] ?? areas.debt).figures.map(metric => {
        const value = metricValue(selected, metric, quality[selected.sha], context?.[selected.sha]);
        const prior = previous ? metricValue(previous, metric, quality[previous.sha], context?.[previous.sha]) : null;
        const change = comparable && !profileChanged && value !== null && prior !== null ? difference(value, prior, metric) : null;
        return { metric, value, change, text: change && change.direction !== 'same' ? change.text : '' };
    });
    // An area with nothing measured at this commit says so once, instead of a row of dashes.
    if (figures.every(entry => entry.value === null)) {
        const empty = document.createElement('p');
        empty.className = 'lead-empty';
        empty.textContent = { coverage: 'No coverage report for this commit.', security: 'No security scanner report for this commit.' }[area]
            ?? 'Not measured for this commit.';
        element('lead').replaceChildren(empty);
        return;
    }
    element('lead').replaceChildren(...figures.map(({ metric, value, change, text }) => {
        const figure = document.createElement('div');
        figure.className = 'figure';
        const label = document.createElement('dt');
        label.textContent = labelOf(metric);
        const shown = document.createElement('dd');
        shown.className = 'figure-value';
        const destination = value === null || value <= 0 ? undefined : figureLink(metric, value, selected.sha, details);
        if (value === null)
            shown.textContent = '—';
        else if (!destination)
            shown.textContent = formatMetric(value, metric);
        else {
            const anchor = document.createElement('a');
            anchor.href = destination;
            anchor.textContent = formatMetric(value, metric);
            shown.append(anchor);
        }
        const delta = document.createElement('dd');
        delta.className = 'figure-delta';
        delta.textContent = text;
        delta.dataset.direction = change?.direction ?? 'none';
        if (text)
            delta.title = `Since ${before} (${previous.sha.slice(0, 7)})`;
        figure.append(label, shown, delta);
        return figure;
    }));
}
/**
 * Where a lead figure leads, when it counts things the report lists: remediation time to the code smells it prices,
 * duplication to the duplicated code, uncovered lines to the files that hold them, security counts to the findings,
 * and the most complex function to its line. Ratios and sizes lead nowhere.
 */
function figureLink(metric, value, sha, details) {
    switch (metric) {
        case 'effort': return smellsLink(sha);
        case 'duplication': return href({ page: 'issues', sha, category: 'duplication' });
        case 'uncovered-lines': return uncoveredLink(sha);
        case 'security': return securityLink(sha);
        case 'security-high': return securityLink(sha, 'high');
        case 'security-medium': return securityLink(sha, 'medium');
        case 'security-low': return securityLink(sha, 'low');
        case 'complexity': {
            const top = details?.functions.find(item => item.complexity === value);
            if (!top)
                return undefined;
            const slash = top.path.lastIndexOf('/');
            return href({ page: 'metrics', sha, file: top.path, directory: slash < 0 ? '' : top.path.slice(0, slash), ...top.line ? { line: top.line } : {} });
        }
        default: return undefined;
    }
}
/** A small progress ring for a ratio; an empty ring when there is no value. */
function ring(ratio) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const track = document.createElementNS(namespace, 'circle');
    const arc = document.createElementNS(namespace, 'circle');
    for (const circle of [track, arc]) {
        circle.setAttribute('cx', '20');
        circle.setAttribute('cy', '20');
        circle.setAttribute('r', '16');
    }
    track.setAttribute('class', 'ring-track');
    arc.setAttribute('class', 'ring-arc');
    const length = 2 * Math.PI * 16;
    arc.setAttribute('stroke-dasharray', `${(ratio ?? 0) * length} ${length}`);
    // Flat ends keep the gap true to the value: a round cap would close 95.9% into a full circle and turn
    // a zero into a dot. An unknown or zero ratio shows the track alone.
    svg.append(...(ratio !== null && ratio > 0 ? [track, arc] : [track]));
    return svg;
}
function renderScannerContext(context, sha) {
    const security = context?.security;
    const mark = element('security-mark');
    const critical = security?.critical ?? 0;
    const total = security ? critical + security.high + security.medium + security.low + security.unknown : null;
    // A grade like maintainability's, by the worst finding: the line beside it gives the counts per risk level.
    const step = !security ? null : critical ? 4 : security.high ? 3 : security.medium ? 2 : total ? 1 : 0;
    mark.textContent = step === null ? '–' : securityGrades[step];
    mark.title = step === null ? '' : `Security ${securityGrades[step]}: ${securityRisks[step].toLowerCase()}`;
    // The same five steps as every grade: clear A, low B, medium C, high D, critical F.
    mark.dataset.severity = !security ? 'none' : critical ? 'critical' : security.high ? 'high' : security.medium ? 'medium' : total ? 'low' : 'clear';
    // The mark carries the level; the text gives the counts by severity.
    const levels = security ? [['critical', critical], ['high', security.high], ['medium', security.medium], ['low', security.low], ['unclassified', security.unknown]]
        .filter(([, amount]) => amount > 0) : [];
    detailText('security-detail', !security ? 'No scanner report'
        : levels.length === 0 ? 'No findings'
            : levels.map(([name, amount]) => `${count(amount)} ${name}`).join(' · '), levels.length ? securityLink(sha) : undefined);
}
function renderOverviewHotspots(details, sha, chartMetric, scanned) {
    const metric = chartMetric === 'coverage' ? 'missedLines' : chartMetric === 'cognitive' || chartMetric === 'duplication'
        ? chartMetric : 'complexity';
    const output = element('overview-hotspot-list');
    const aside = element('overview-hotspots');
    aside.removeAttribute('aria-busy');
    aside.classList.remove('overview-stale');
    listHeading(true);
    if (chartMetric === 'security') {
        renderSecurityHotspots(details, sha, scanned);
        return;
    }
    const labels = {
        complexity: 'Maintainability hotspots',
        cognitive: 'Cognitive complexity hotspots',
        duplication: 'Duplication hotspots',
        missedLines: 'Coverage hotspots',
    };
    element('overview-hotspots-title').textContent = labels[metric];
    const ranks = details.metrics.hotspots[metric] ?? [];
    const chart = element('overview-sunburst');
    const map = () => chart.replaceChildren(renderSunburst(details, {
        metric, compact: true, href: (page, options) => href({ page, sha, ...options }), reshape: map,
    }));
    map();
    const byPath = new Map(details.metrics.files.map(file => [file.path, file]));
    const list = document.createElement('ol');
    list.className = 'overview-hotspot-list';
    const all = document.querySelector('#all-hotspots');
    all.href = href({ page: 'hotspots', sha });
    all.hidden = false;
    const top = ranks.slice(0, 5).map(path => {
        const entry = byPath.get(path);
        const lines = entry?.lineCoverage;
        const value = metric === 'missedLines' ? (lines ? lines.total - lines.covered : null)
            : metric === 'duplication' ? entry?.quality?.duplication?.duplicatedLines ?? null
                : metric === 'cognitive' ? entry?.quality?.cognitiveComplexity ?? null : entry?.complexity?.maximum ?? null;
        return { path, value, entry };
    });
    for (const { path, value, entry } of top) {
        const link = document.createElement('a');
        const slash = path.lastIndexOf('/');
        const directory = slash < 0 ? '' : path.slice(0, slash);
        link.href = href({ page: 'metrics', sha, file: path, directory });
        const label = document.createElement('span');
        label.className = 'hotspot-name';
        const name = document.createElement('strong');
        name.textContent = path.slice(slash + 1);
        label.append(name);
        // A file in the repository root has no folder to name.
        if (directory) {
            const parent = document.createElement('small');
            parent.textContent = directory;
            label.append(parent);
        }
        const score = document.createElement('span');
        score.className = 'chip';
        score.textContent = count(value);
        if (value !== null && entry)
            score.dataset.band = String(band(entry, metric, value, Math.max(1, ...top.map(item => item.value ?? 0)), bandLimits(details, metric)));
        link.append(label, score);
        const row = document.createElement('li');
        row.append(link);
        list.append(row);
    }
    if (list.childElementCount)
        output.replaceChildren(list);
    else if (metric === 'missedLines' && !details.metrics.files.some(file => file.lineCoverage))
        unranked();
    else
        notice(output, 'No files in this ranking.');
}
/** The ranking's heading and link show only when there is something to rank. */
function listHeading(visible) {
    element('overview-hotspots-title').parentElement.hidden = !visible;
}
/** Nothing measured: the grey map stands alone; the quality area's tab already says what is missing. */
function unranked() {
    listHeading(false);
    element('overview-hotspot-list').replaceChildren();
}
/**
 * Security has no measure of its own on the map: the map shows sizes in grey, and the list ranks files by their
 * scanner findings. Without a scanner report there is nothing to rank, and the grey map says so.
 */
function renderSecurityHotspots(details, sha, scanned) {
    element('overview-hotspots-title').textContent = 'Security hotspots';
    const sensitive = new Set(['security', 'dependency', 'secret', 'infrastructure']);
    // Each file's worst finding, in the steps of the security mark; until findings carry a critical level, high is the top.
    const rank = { low: 1, unknown: 1, medium: 2, high: 3 };
    const levels = new Map();
    for (const finding of details.findings ?? []) {
        if (sensitive.has(finding.category) && finding.path)
            levels.set(finding.path, Math.max(levels.get(finding.path) ?? 0, rank[finding.level]));
    }
    const chart = element('overview-sunburst');
    const map = () => chart.replaceChildren(renderSunburst(details, {
        metric: 'complexity', compact: true, href: (page, options) => href({ page, sha, ...options }), reshape: map,
        ...scanned ? { levels } : { muted: true },
    }));
    map();
    const all = document.querySelector('#all-hotspots');
    all.href = href({ page: 'issues', sha });
    all.hidden = !scanned;
    const output = element('overview-hotspot-list');
    if (!scanned) {
        unranked();
        return;
    }
    const counts = new Map();
    for (const finding of details.findings ?? []) {
        if (sensitive.has(finding.category) && finding.path)
            counts.set(finding.path, (counts.get(finding.path) ?? 0) + 1);
    }
    // The worst level first, then the most findings; the chip names the level, as the map colours it.
    const top = [...levels].sort((a, b) => b[1] - a[1] || counts.get(b[0]) - counts.get(a[0]) || a[0].localeCompare(b[0])).slice(0, 5);
    if (!top.length) {
        notice(output, 'No security findings.');
        return;
    }
    const list = document.createElement('ol');
    list.className = 'overview-hotspot-list';
    for (const [path, level] of top) {
        const link = document.createElement('a');
        const slash = path.lastIndexOf('/');
        link.href = href({ page: 'issues', sha, query: path });
        const label = document.createElement('span');
        label.className = 'hotspot-name';
        const name = document.createElement('strong');
        name.textContent = path.slice(slash + 1);
        label.append(name);
        if (slash > 0) {
            const parent = document.createElement('small');
            parent.textContent = path.slice(0, slash);
            label.append(parent);
        }
        const score = document.createElement('span');
        score.className = 'chip chip-level';
        score.dataset.level = String(level);
        score.textContent = securityGrades[level];
        score.title = `${securityRisks[level]} · ${quantity(counts.get(path), 'finding')}`;
        link.append(label, score);
        const row = document.createElement('li');
        row.append(link);
        list.append(row);
    }
    output.replaceChildren(list);
}
function renderTrend(data, selected, metric, compact) {
    // Enough inspections to show a curve, not a pair of dots; the Trends page holds the whole history.
    const size = compact ? 24 : 60;
    const { start, end } = stableWindow(data.reports, data.reports.indexOf(selected), size, 'overview');
    const shown = charted(data.reports.slice(start, end).reverse());
    const link = (sha) => href({ page: 'overview', sha });
    const chart = element('chart');
    const hasData = renderSeries(chart, element('trend-key'), data, shown, metric, selected.sha, link, { compact, height: compact ? undefined : 296, labelCurrent: false });
    chart.hidden = !hasData;
    element('trend-empty').hidden = hasData;
    // With no chart, its empty line is the panel's one statement: no key, no reading notes, no second "not measured".
    element('trend').dataset.empty = String(!hasData);
    const points = seriesPoints(data, shown, metric, selected.sha, link);
    // The figures under the chart state the value and its change, so the chart is named for screen readers only.
    element('trend-title').textContent = `${labelOf(metric)} by commit`;
    const legend = trendLegend(points, data);
    element('trend-detail').textContent = legend;
    element('trend-detail').hidden = legend === '' || !hasData;
}
function coverageText(value) {
    return formatPercent(value && value.total > 0 ? value.covered / value.total : null);
}
function formatPercent(value) {
    return value === null ? '—' : percent.format(value);
}
function element(id) {
    return document.getElementById(id);
}
/**
 * The hotspot column while the inspection loads. A map and ranking already on screen stay, dimmed, until the next ones
 * replace them; on a first visit placeholders of the same size hold the column, so nothing beside it moves.
 */
function overviewStub(sha) {
    const chart = element('overview-sunburst');
    const output = element('overview-hotspot-list');
    const all = document.querySelector('#all-hotspots');
    all.href = href({ page: 'hotspots', sha });
    all.hidden = false;
    const aside = element('overview-hotspots');
    aside.setAttribute('aria-busy', 'true');
    listHeading(true);
    if (chart.querySelector('.fx-sunburst:not(.fx-map-stub)') && output.querySelector('.overview-hotspot-list')) {
        aside.classList.add('overview-stale');
        return;
    }
    chart.replaceChildren(mapStub());
    const list = document.createElement('ol');
    list.className = 'overview-hotspot-list overview-hotspot-stub';
    for (let row = 0; row < 5; row++) {
        const item = document.createElement('li');
        item.innerHTML = '<span><span class="stub-line"></span><span class="stub-line stub-line-short"></span></span><span class="stub-chip"></span>';
        list.append(item);
    }
    output.replaceChildren(list);
}
function notice(container, text) {
    const paragraph = document.createElement('p');
    paragraph.className = 'detail empty';
    paragraph.setAttribute('role', 'status');
    paragraph.textContent = text;
    container.replaceChildren(paragraph);
}
async function readJson(path) {
    const response = await fetch(path);
    if (!response.ok)
        throw new Error(`Could not read ${path}`);
    return await response.json();
}
async function readOptional(path) {
    try {
        return await readJson(path);
    }
    catch {
        return null;
    }
}
