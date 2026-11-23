import { renderBarChart, renderLineChart } from './viewer-chart.js';
import { splitter } from './viewer-files.js';
import { betterOf, definitionOf, difference, formatMetric, isMetric, isPercent, labelOf, metricValue, pluginMetrics, pluginSpec } from './viewer-metrics.js';
const statusLabels = { complete: 'Complete', partial: 'Partial', 'not-applicable': 'Not applicable' };
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pageRows = 50;
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const ownLabels = {
    debt: 'Technical debt', 'debt-changes': 'Technical debt changes', 'diff-coverage': 'Changed-line coverage',
};
function viewLabel(view) {
    return ownLabels[view] ?? labelOf(view);
}
const builtinGroups = [
    ['Maintainability', ['debt', 'debt-changes', 'duplication', 'cognitive', 'complexity', 'smells']],
    ['Coverage', ['coverage', 'diff-coverage']],
    ['Security', ['security']],
    ['Size', ['code-lines', 'files', 'functions', 'classes', 'comments']],
];
/** The series list: Repometry's own groups, with other plugins' metrics joining a group they name or one of their own. */
function groups() {
    const merged = new Map(builtinGroups.map(([group, views]) => [group, [...views]]));
    for (const spec of pluginMetrics()) {
        if (spec.trend)
            merged.set(spec.group, [...merged.get(spec.group) ?? [], spec.key]);
    }
    return [...merged];
}
export function isTrendView(value) {
    return value === 'debt-changes' || value === 'diff-coverage' || (isMetric(value) && groups().some(([, views]) => views.includes(value)));
}
export function isPeriod(value) {
    return value === '30' || value === '100' || value === 'all';
}
/** Views that have data in this history, in display order. */
export function availableViews(data) {
    const has = (metric) => data.reports.some(report => value(data, report, metric) !== null);
    return groups().flatMap(([, views]) => views).filter(view => view === 'diff-coverage' ? data.detailed : view === 'debt-changes' ? has('effort') : has(view));
}
/** The whole curve by default; only a very long history opens on its last hundred inspections. */
export function defaultPeriod(total) {
    return total <= 1000 ? 'all' : '100';
}
/** The inspections shown for a period, oldest first, always including the selected one. */
export function windowOf(reports, selected, period) {
    const limit = period === 'all' ? reports.length : Number(period);
    const { start, end } = stableWindow(reports, reports.indexOf(selected), limit, 'trends');
    return reports.slice(start, end).reverse();
}
const windows = new Map();
/**
 * The slice of history a chart shows, newest first by index. Picking a commit inside the current slice keeps it, so
 * the axes and scale stay where the eye left them; only a commit outside it moves the slice, which then centres on
 * that commit so its neighbours on both sides are in view. The newest commits are the default slice.
 */
export function stableWindow(reports, index, size, key) {
    const total = reports.length;
    const head = reports[0]?.sha;
    const previous = windows.get(key);
    let result;
    if (previous && previous.size === size && previous.total === total && previous.head === head
        && index >= previous.start && index < previous.end)
        result = { start: previous.start, end: previous.end };
    else if (index < size)
        result = { start: 0, end: Math.min(size, total) };
    else {
        const end = Math.min(total, Math.max(0, index - Math.floor(size / 2)) + size);
        result = { start: Math.max(0, end - size), end };
    }
    windows.set(key, { ...result, size, total, head });
    return result;
}
/**
 * The inspections a time chart can place: when the history has commit times, one without (a root commit has no churn
 * window to read it from) cannot be put on the time axis, so it stays out of the chart and in the table.
 */
export function charted(shown) {
    const timed = shown.filter(report => commitTime(report) !== null);
    return timed.length ? timed : [...shown];
}
/** Commit time of an inspection, or null for exports made before commit times were recorded. */
export function commitTime(report) {
    const time = report.committedAt === undefined ? NaN : Date.parse(report.committedAt);
    return Number.isFinite(time) ? time : null;
}
export function seriesPoints(data, shown, metric, selected, link) {
    const points = shown.map(report => {
        const measured = value(data, report, metric);
        const previous = data.reports[data.reports.indexOf(report) + 1];
        const before = previous ? value(data, previous, metric) : null;
        const boundary = data.context?.[report.sha]?.boundary ?? null;
        const change = boundary !== 'changed' && measured !== null && before !== null ? difference(measured, before, metric) : null;
        return point(report, measured === null ? 'No measurement' : formatMetric(measured, metric), change, measured, selected, link, boundary);
    });
    const flags = plantFlags(points.map(entry => entry.value), metric);
    return points.map((entry, index) => flags.best === index ? { ...entry, flag: 'best' }
        : flags.worst === index ? { ...entry, flag: 'worst' } : entry);
}
/**
 * Where the green and the red flag stand: the best and the worst value of the series, each at the inspection that
 * first reached it, the way a flag is planted where a summit was reached. Neutral metrics get no flags, and neither
 * does a series with fewer than three measurements or one that reads as unchanged from its best to its worst.
 *
 * The extremes are the raw minimum and maximum, as the line draws them: a tolerant "beats" is not transitive, and a
 * first value within rounding of both ends used to hide them. A value reaches an extreme when it equals it up to
 * floating-point noise, so a flag never stands beside a point the line shows lower or higher.
 */
export function plantFlags(values, metric) {
    const none = { best: null, worst: null };
    const better = betterOf(metric);
    if (better === 'none')
        return none;
    const measured = values.flatMap((entry, index) => entry === null ? [] : [index]);
    if (measured.length < 3)
        return none;
    const raw = measured.map(index => values[index]);
    const lowest = Math.min(...raw);
    const highest = Math.max(...raw);
    const [bestValue, worstValue] = better === 'lower' ? [lowest, highest] : [highest, lowest];
    if (difference(bestValue, worstValue, metric).direction === 'same')
        return none;
    const reached = (target) => measured.find(index => Math.abs(values[index] - target) <= 1e-9 * Math.max(1, Math.abs(target)));
    const best = reached(bestValue);
    const worst = reached(worstValue);
    return best === worst ? none : { best, worst };
}
function point(report, shownValue, change, measured, selected, link, boundary) {
    const time = commitTime(report);
    const inspectedAt = Date.parse(report.generatedAt);
    const when = time !== null ? dateTime.format(time) : Number.isFinite(inspectedAt) ? `Inspected ${dateTime.format(inspectedAt)}` : 'Date unavailable';
    const notes = report.status === 'partial' ? ['Partial inspection'] : [];
    if (boundary)
        notes.push(boundary === 'changed' ? 'Inspection profile changed' : 'Profile comparison unavailable');
    return {
        value: measured, time, boundary,
        label: Number.isFinite(time ?? inspectedAt) ? shortDate.format(time ?? inspectedAt) : report.sha.slice(0, 7),
        title: `${report.sha.slice(0, 7)}, ${when}: ${shownValue}${change && change.direction !== 'same' ? `, ${change.text}` : ''}`,
        tip: { heading: when, commit: report.sha.slice(0, 7), ...(report.subject ? { subject: report.subject } : {}), value: shownValue, change, notes },
        href: link(report.sha),
        current: report.sha === selected,
        partial: report.status === 'partial',
    };
}
/** Only what the chart cannot say by itself; empty when there is nothing to add. */
export function trendLegend(points, data) {
    const parts = [
        points.some(point => point.partial && point.value !== null) ? 'Dashed dots mark partial inspections' : '',
        points.some(point => point.boundary === 'changed') ? 'Dashed lines mark profile changes' : '',
        points.some(point => point.boundary === 'unavailable') ? 'Dotted lines mark missing profile information' : '',
    ].filter(Boolean);
    return parts.length ? `${parts.join('. ')}.` : '';
}
/** Renders the whole page; returns the slot for the changed-line coverage history when that view is chosen. */
export function renderTrendsPage(container, data, selected, requested, requestedPeriod) {
    const views = availableViews(data);
    const view = requested && views.includes(requested) ? requested : views.includes('debt') ? 'debt' : views[0] ?? 'code-lines';
    const period = requestedPeriod ?? defaultPeriod(data.reports.length);
    const shown = charted(windowOf(data.reports, selected, period));
    const link = (sha) => data.link(sha, view, period);
    // The chart is the page; the series list is its sidebar, behind the same draggable separator as everywhere.
    const layout = element('div', 'trends-layout fx-split');
    const main = element('div', 'trend-main');
    layout.append(main, splitter(layout), viewNavigation(data, views, view, selected, period));
    const head = element('div', 'trend-head');
    const heading = element('div');
    const headline = element('h2', 'trend-headline');
    const definition = element('p', 'detail', view === 'debt-changes' ? 'Change in estimated remediation time from the previous inspection.'
        : view === 'diff-coverage' ? 'Coverage of added lines in saved pull request reviews, against each review threshold.'
            : definitionOf(view));
    heading.append(headline);
    head.append(heading);
    // The title stands above the frame; the frame holds the period, the chart, its key, and what the series means.
    const frame = element('div', 'trend-frame panel');
    const tools = element('div', 'trend-frame-tools');
    tools.append(periodControl(data, selected.sha, view, period));
    frame.append(tools);
    main.append(head, frame);
    let slot = null;
    let legend = '';
    if (view === 'diff-coverage') {
        headline.textContent = viewLabel('diff-coverage');
        slot = element('div', 'trend-slot');
        frame.append(slot);
    }
    else if (view === 'debt-changes') {
        const effort = seriesPoints(data, shown, 'effort', selected.sha, link);
        const bars = effort.map((point, index) => {
            // The first shown inspection compares with the one just before the window, when there is one.
            const report = shown[index];
            const previous = data.reports[data.reports.indexOf(report) + 1];
            const before = previous ? value(data, previous, 'effort') : null;
            const change = point.boundary !== 'changed' && point.value !== null && before !== null ? point.value - before : null;
            const reason = !previous ? 'First inspection' : point.boundary === 'changed' ? 'Profile changed' : 'Not measured before';
            const total = point.value === null ? 'No measurement' : `${formatMetric(point.value, 'effort')} in total`;
            const shownChange = change === null ? reason : signedDuration(change);
            // Flags mark the best and worst total; the bars show per-inspection changes, so they carry none.
            return { ...point, value: change, flag: undefined,
                title: `${report.sha.slice(0, 7)}, ${point.tip.heading}: ${shownChange}`,
                tip: { ...point.tip, value: shownChange, change: null, notes: [total, ...point.tip.notes] } };
        });
        headline.textContent = viewLabel('debt-changes');
        const chart = element('div', 'chart');
        frame.append(chart);
        renderBarChart(chart, bars, { format: signedDuration, compact: data.compact, upIsWorse: true, tickUnit: tickUnit(bars, 'effort') });
        legend = trendLegend(bars, data);
    }
    else {
        // The same chart as the Overview: the series, its companion in grey, and a key that switches either line.
        // The title repeats the item chosen in the sidebar; the key under the chart names each line.
        headline.textContent = viewLabel(view);
        const chart = element('div', 'chart');
        const key = element('p', 'trend-key');
        frame.append(chart, key);
        if (!renderSeries(chart, key, data, shown, view, selected.sha, link, { compact: data.compact })) {
            chart.append(element('p', 'detail empty', 'No measurements for this series in the shown inspections.'));
        }
        legend = trendLegend(seriesPoints(data, shown, view, selected.sha, link), data);
    }
    frame.append(definition);
    if (legend)
        frame.append(element('p', 'detail legend', legend));
    container.replaceChildren(layout);
    return slot;
}
function viewNavigation(data, views, current, selected, period) {
    const sha = selected.sha;
    const wrapper = element('aside', 'trend-picker fx-aside');
    const navigation = element('nav', 'trend-nav');
    navigation.setAttribute('aria-label', 'Trend series');
    const select = document.createElement('select');
    for (const [group, members] of groups()) {
        const present = members.filter(view => views.includes(view));
        if (!present.length)
            continue;
        const block = element('div', 'trend-group');
        const title = element('h3', '', group);
        const reading = groupReading(data, selected, group);
        if (reading)
            title.append(reading);
        block.append(title);
        const list = element('ul');
        const options = document.createElement('optgroup');
        options.label = group;
        for (const view of present) {
            const item = element('li');
            const link = element('a', '', viewLabel(view));
            link.href = data.link(sha, view, period);
            // Each series carries its value at the selected commit, in the tabs' counter.
            const metric = view === 'debt-changes' || view === 'diff-coverage' ? null : view;
            const reading = metric === null ? null : value(data, selected, metric);
            // The group's own label carries the signal (the grade, the coverage); a row reads like a summary table.
            if (metric !== null && reading !== null)
                link.append(element('span', 'trend-value', formatMetric(reading, metric)));
            if (view === current)
                link.setAttribute('aria-current', 'page');
            item.append(link);
            list.append(item);
            options.append(new Option(viewLabel(view), view, false, view === current));
        }
        block.append(list);
        navigation.append(block);
        select.append(options);
    }
    select.addEventListener('change', () => { location.hash = data.link(sha, select.value, period); });
    const label = element('label', 'trend-select', 'Series');
    label.append(select);
    wrapper.append(navigation, label);
    return wrapper;
}
/**
 * What a quality group comes to at the selected commit, in the label the Overview uses for it: the maintainability
 * grade in its colour and line coverage (green from 95%). Other groups carry no total: it would repeat a row.
 */
function groupReading(data, selected, group) {
    if (group === 'Maintainability') {
        const grade = data.quality[selected.sha]?.maintainability?.grade;
        if (!grade)
            return null;
        const label = element('span', 'trend-reading trend-reading-grade', grade);
        label.dataset.grade = grade;
        return label;
    }
    if (group === 'Coverage') {
        const ratio = value(data, selected, 'coverage');
        if (ratio === null)
            return null;
        const label = element('span', 'trend-reading', formatMetric(ratio, 'coverage'));
        if (ratio >= .95)
            label.classList.add('trend-reading-good');
        return label;
    }
    return null;
}
function periodControl(data, sha, view, period) {
    // The choices say what they are ("Last 100 inspections"), so the label is for screen readers only.
    const label = element('label', 'trend-period');
    label.append(element('span', 'visually-hidden', 'Period'));
    const select = document.createElement('select');
    const total = data.reports.length;
    for (const option of ['30', '100']) {
        if (Number(option) < total)
            select.append(new Option(`Last ${option} inspections`, option, false, option === period));
    }
    select.append(new Option(`All ${total} inspections`, 'all', false, period === 'all' || Number(period) >= total));
    select.addEventListener('change', () => { location.hash = data.link(sha, view, select.value); });
    label.append(select);
    return label;
}
/** The measure drawn beside a series as a grey line on its own scale: the time behind the ratio, the lines behind the share. */
export const companions = { debt: 'effort', coverage: 'uncovered-lines' };
const hiddenKey = 'repometry.hidden-series';
let hiddenSeries;
function hidden() {
    if (!hiddenSeries) {
        try {
            hiddenSeries = new Set(JSON.parse(localStorage.getItem(hiddenKey) ?? '[]'));
        }
        catch {
            hiddenSeries = new Set();
        }
    }
    return hiddenSeries;
}
function remember() {
    try {
        localStorage.setItem(hiddenKey, JSON.stringify([...hidden()]));
    }
    catch {
        // Without storage the choice lasts for this page only.
    }
}
/**
 * A series with its companion, as the Overview draws it: the series in ink on the left scale, the companion in grey on
 * the right, and a key whose entries switch each line on and off. The last line shown cannot be switched off; with one
 * left it takes the left scale. The choice is remembered for this viewer. Returns whether anything was drawn.
 */
export function renderSeries(chart, key, data, shown, metric, selected, link, options) {
    const pair = companions[metric];
    const second = pair ? shown.map(report => value(data, report, pair)) : [];
    // A companion earns its line only once it can draw one, that is, from two measurements on.
    const paired = pair !== undefined && second.filter(item => item !== null).length >= 2;
    const main = seriesPoints(data, shown, metric, selected, link);
    const hasData = main.some(point => point.value !== null) || (paired && second.some(item => item !== null));
    function draw() {
        const showMain = !paired || !hidden().has(metric);
        const showSecond = paired && !hidden().has(pair);
        const lead = showMain ? metric : pair;
        const base = showMain ? main : seriesPoints(data, shown, pair, selected, link);
        // The card under the pointer names the grey series too.
        const points = showMain && showSecond ? base.map((point, index) => second[index] == null ? point
            : { ...point, tip: { ...point.tip, notes: [`${labelOf(pair)}: ${formatMetric(second[index], pair)}`, ...point.tip.notes] } }) : base;
        chart.classList.toggle('chart-companion-only', !showMain);
        if (points.some(point => point.value !== null)) {
            renderLineChart(chart, points, { format: number => formatMetric(number, lead), ratio: isPercent(lead), compact: options.compact,
                height: options.height, tickUnit: tickUnit(points, lead), labelCurrent: options.labelCurrent ?? true,
                secondary: showMain && showSecond ? { values: second, format: number => formatMetric(number, pair), tickUnit: tickUnit(second.map(item => ({ value: item })), pair) } : undefined });
        }
        else
            chart.replaceChildren(element('p', 'detail empty', 'No measurements for this series in the shown inspections.'));
        key.hidden = !paired;
        if (!paired) {
            key.replaceChildren();
            return;
        }
        key.replaceChildren(...[[metric, 'main', showMain], [pair, 'second', showSecond]].map(([series, kind, on]) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `trend-key-item trend-key-${kind}`;
            item.textContent = labelOf(series);
            item.setAttribute('aria-pressed', String(on));
            // The one line left stays: a chart of nothing says nothing.
            item.disabled = on && !(showMain && showSecond);
            item.addEventListener('click', () => {
                if (on)
                    hidden().add(series);
                else
                    hidden().delete(series);
                remember();
                draw();
                key.querySelector(`.trend-key-${kind}`)?.focus();
            });
            return item;
        }));
    }
    if (hasData)
        draw();
    else {
        chart.replaceChildren();
        key.hidden = true;
    }
    return hasData;
}
/** Remediation time ticks in whole hours once the series reaches two hours. */
export function tickUnit(points, metric) {
    const minutes = metric === 'effort' || pluginSpec(metric)?.descriptor.unit === 'minutes';
    return minutes && points.some(point => Math.abs(point.value ?? 0) >= 120) ? 60 : 1;
}
function value(data, report, metric) {
    return metricValue(report, metric, data.quality[report.sha], data.context?.[report.sha]);
}
function signedDuration(minutes) {
    if (Math.round(minutes) === 0)
        return '0 min';
    return `${minutes > 0 ? '+' : '−'}${formatMetric(Math.abs(minutes), 'effort')}`;
}
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
