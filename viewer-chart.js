// Line and bar charts for the viewer. Drawn as SVG at the container's pixel width,
// so labels keep their size on every screen. Colours come from CSS classes and theme tokens.
const flagNotes = { best: 'Best of the shown inspections', worst: 'Worst of the shown inspections' };
const svgNamespace = 'http://www.w3.org/2000/svg';
const observed = new WeakMap();
const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    for (const entry of entries) {
        const record = observed.get(entry.target);
        const width = Math.round(entry.contentRect.width);
        if (record && width > 0 && width !== record.width) {
            record.width = width;
            record.draw(width);
        }
    }
});
/** Draws into the container now and again whenever its width changes. */
function mount(container, draw) {
    const width = Math.round(container.clientWidth);
    observed.set(container, { width, draw });
    observer?.observe(container);
    draw(width || 640);
}
export function renderLineChart(container, points, options) {
    mount(container, width => draw(container, points, width, options.height ?? (options.compact ? 200 : 248), (svg, layout) => lineChart(svg, layout, points, options)));
}
/** Diverging bars around zero, one per point; a point without a value gets a mark on the zero line. */
export function renderBarChart(container, points, options) {
    mount(container, width => draw(container, points, width, options.compact ? 200 : 248, (svg, layout) => barChart(svg, layout, points, options)));
}
const top = 34;
const bottom = 30;
const right = 18;
/** Keeps the first and last marks off the plot edges. */
const inset = 12;
function draw(container, points, width, height, body) {
    const layout = { width, height, top, plotHeight: height - top - bottom, left: 0, plotWidth: 0, xs: [], ys: [] };
    const svg = svgElement('svg', 'tc');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    body(svg, layout);
    const tip = document.createElement('div');
    tip.className = 'tc-tip';
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    container.classList.add('chart-interactive');
    container.replaceChildren(svg, tip);
    interact(svg, tip, layout, points);
}
/**
 * Positions points on the x axis and draws it. When every point has a commit time the axis is time: equal periods take
 * equal width, and the ticks step by one calendar period (a day, a week, a month, a quarter, a year) chosen to fit the
 * width. Without times the points stand evenly in order under their own labels.
 */
function placeX(svg, layout, points) {
    const { left, plotWidth, top: plotTop, plotHeight, height } = layout;
    const from = left + inset;
    const span = Math.max(1, plotWidth - inset * 2);
    const times = points.map(point => point.time);
    const timed = points.length > 0 && times.every((time) => time !== null);
    const axis = plotTop + plotHeight;
    if (timed) {
        const low = Math.min(...times);
        const high = Math.max(...times);
        const at = (time) => high === low ? from + span / 2 : from + (time - low) / (high - low) * span;
        layout.xs = times.map(at);
        if (high === low)
            return;
        const ticks = timeTicks(low, high, span);
        for (const tick of ticks) {
            const mark = svgElement('line', 'tc-xtick');
            setAttributes(mark, { x1: at(tick.time), x2: at(tick.time), y1: axis, y2: axis + 4 });
            svg.append(mark);
        }
        for (const label of axisLabels(ticks.map(tick => ({ time: tick.time, x: at(tick.time) })), ticks[0]?.unit ?? 'day', layout)) {
            const node = text(label.label, 'tc-label', label.at, height - 9);
            node.setAttribute('text-anchor', 'middle');
            svg.append(node);
        }
        return;
    }
    const step = points.length > 1 ? span / (points.length - 1) : 0;
    layout.xs = points.map((_, index) => points.length > 1 ? from + index * step : from + span / 2);
    const labelWidth = Math.max(...points.map(point => point.label.length)) * 7.6 + 10;
    const every = step > 0 ? Math.max(1, Math.ceil(labelWidth / step)) : 1;
    const last = points.length - 1;
    for (const [index, point] of points.entries()) {
        const near = index !== last && last - index < every;
        if ((index % every !== 0 || near) && index !== last)
            continue;
        const label = text(point.label, 'tc-label', clampLabel(layout.xs[index], point.label, layout), height - 9);
        label.setAttribute('text-anchor', 'middle');
        svg.append(label);
    }
}
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthYearLabel = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayYearLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
/**
 * Labels for ticks in time order. Each names its own unit, and the coarser units join it only where they change:
 * Jul 2023, Nov, Dec, Jan 2024, Feb; 30 Jun, 1 Jul, 2; 23:00, 1 Jul, 01:00. The first tick always carries them.
 */
export function tickLabels(times, unit) {
    let previous = null;
    return times.map(time => {
        const date = new Date(time);
        const year = previous === null || previous.getFullYear() !== date.getFullYear();
        const month = year || previous.getMonth() !== date.getMonth();
        const today = month || previous.getDate() !== date.getDate();
        previous = date;
        if (unit === 'year')
            return String(date.getFullYear());
        if (unit === 'month')
            return (year ? monthYearLabel : monthLabel).format(date);
        if (unit === 'day')
            return year ? dayYearLabel.format(date) : month ? dayLabel.format(date) : String(date.getDate());
        if (!today)
            return hourLabel.format(date);
        const days = (year ? dayYearLabel : dayLabel).format(date);
        return date.getHours() === 0 && date.getMinutes() === 0 ? days : `${days}, ${hourLabel.format(date)}`;
    });
}
/**
 * The labels under the ticks. Which ticks keep a label is settled first: one that would sit far off its tick at the
 * edge, or touch the label before it, keeps only its mark. Only then are the labels written, so the first label shown
 * carries the coarser units, and every later one carries them only where they change.
 */
export function axisLabels(ticks, unit, layout) {
    let shown = [...ticks];
    for (;;) {
        const labels = tickLabels(shown.map(tick => tick.time), unit);
        let previous = -Infinity;
        const placed = [];
        const drop = shown.findIndex((tick, index) => {
            const label = labels[index];
            const at = clampLabel(tick.x, label, layout);
            const half = label.length * 3.7;
            if (Math.abs(at - tick.x) > 12 || at - half < previous + 10)
                return true;
            previous = at + half;
            placed.push({ at, label });
            return false;
        });
        if (drop < 0)
            return placed;
        shown = shown.filter((_, index) => index !== drop);
    }
}
function clampLabel(x, label, { left, plotWidth }) {
    const half = label.length * 3.6 + 2;
    return Math.min(Math.max(x, left + half), left + plotWidth - half);
}
const minute = 60e3;
const hour = 60 * minute;
const day = 24 * hour;
const steps = [
    { unit: 'minute', count: 5, size: 5 * minute }, { unit: 'minute', count: 10, size: 10 * minute },
    { unit: 'minute', count: 15, size: 15 * minute }, { unit: 'minute', count: 30, size: 30 * minute },
    { unit: 'hour', count: 1, size: hour }, { unit: 'hour', count: 3, size: 3 * hour }, { unit: 'hour', count: 6, size: 6 * hour },
    { unit: 'hour', count: 12, size: 12 * hour }, { unit: 'day', count: 1, size: day }, { unit: 'day', count: 2, size: 2 * day },
    { unit: 'day', count: 7, size: 7 * day }, { unit: 'day', count: 14, size: 14 * day }, { unit: 'month', count: 1, size: 30.4 * day },
    { unit: 'month', count: 3, size: 91 * day }, { unit: 'month', count: 6, size: 182 * day }, { unit: 'year', count: 1, size: 365 * day },
    { unit: 'year', count: 2, size: 730 * day }, { unit: 'year', count: 5, size: 1826 * day },
];
/** Calendar-aligned ticks between two times, as many as fit the width without overlapping labels. */
export function timeTicks(start, end, width) {
    for (const step of steps) {
        if ((end - start) / step.size > Math.max(2, width / 64))
            continue;
        const ticks = calendarTicks(start, end, step.unit, step.count);
        // Sized by the typical label: the few that carry a year or a date beside them are placed with care by the axis.
        const lengths = ticks.map(tick => tick.label.length).sort((x, y) => x - y);
        const widest = (lengths[Math.floor(lengths.length / 2)] ?? 0) * 7.4 + 14;
        if (ticks.length < 2 || (width / Math.max(1, (end - start) / step.size)) >= widest)
            return ticks;
    }
    return calendarTicks(start, end, 'year', 10);
}
function calendarTicks(start, end, unit, count) {
    const ticks = [];
    const cursor = new Date(start);
    cursor.setSeconds(0, 0);
    if (unit !== 'minute')
        cursor.setMinutes(0);
    if (unit !== 'minute' && unit !== 'hour')
        cursor.setHours(0);
    if (unit === 'month' || unit === 'year')
        cursor.setDate(1);
    if (unit === 'year')
        cursor.setMonth(0);
    const advance = () => {
        if (unit === 'minute')
            cursor.setMinutes(cursor.getMinutes() + 1);
        else if (unit === 'hour')
            cursor.setHours(cursor.getHours() + 1);
        else if (unit === 'day')
            cursor.setDate(cursor.getDate() + 1);
        else if (unit === 'month')
            cursor.setMonth(cursor.getMonth() + 1);
        else
            cursor.setFullYear(cursor.getFullYear() + 1);
    };
    const aligned = () => unit === 'minute' ? cursor.getMinutes() % count === 0
        : unit === 'hour' ? cursor.getHours() % count === 0
            : unit === 'day' ? (count === 7 || count === 14 ? cursor.getDay() === 1 && (count === 7 || weekOf(cursor) % 2 === 0) : (cursor.getDate() - 1) % count === 0 && cursor.getDate() < 31)
                : unit === 'month' ? cursor.getMonth() % count === 0 : cursor.getFullYear() % count === 0;
    let guard = 0;
    while (cursor.getTime() < start && guard++ < 6000)
        advance();
    while (cursor.getTime() <= end && guard++ < 6000) {
        if (aligned()) {
            const time = cursor.getTime();
            ticks.push({ time, label: '', unit });
        }
        advance();
    }
    const labels = tickLabels(ticks.map(tick => tick.time), unit);
    return ticks.map((tick, index) => ({ time: tick.time, label: labels[index], unit }));
}
function weekOf(date) {
    return Math.floor(date.getTime() / (7 * day));
}
function yAxis(svg, layout, values, ratio, count, format, tickUnit, zero, rightLabels) {
    const ticks = niceTicks((zero ? [...values, 0] : values).map(value => value / tickUnit), ratio, count).map(tick => tick * tickUnit);
    const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    const digits = Math.min(3, Math.max(0, -Math.floor(Math.log10(tickStep * 100) + 1e-9)));
    const tickPercent = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits });
    const labels = ticks.map(tick => zero && tick === 0 ? '0' : ratio ? tickPercent.format(tick) : format(tick));
    layout.left = Math.ceil(Math.max(...labels.map(tickWidth))) + 12;
    // A second scale takes a label column at the right, one label per grid line.
    const secondLabels = rightLabels?.(ticks.length) ?? [];
    const reserve = secondLabels.length ? Math.ceil(Math.max(...secondLabels.map(tickWidth))) + 12 - right : 0;
    layout.plotWidth = Math.max(40, layout.width - layout.left - right - reserve);
    const low = ticks[0];
    const high = ticks.at(-1);
    const y = (value) => layout.top + layout.plotHeight - (high === low ? .5 : (value - low) / (high - low)) * layout.plotHeight;
    for (const [index, tick] of ticks.entries()) {
        const line = svgElement('line', (zero ? tick === 0 : index === 0) ? 'tc-base' : 'tc-grid');
        setAttributes(line, { x1: layout.left, x2: layout.left + layout.plotWidth, y1: y(tick), y2: y(tick) });
        const label = text(labels[index], 'tc-tick', layout.left - 8, y(tick) + 4.5);
        label.setAttribute('text-anchor', 'end');
        svg.append(line, label);
        const second = secondLabels[index];
        if (second !== undefined)
            svg.append(text(second, 'tc-tick tc-tick-secondary', layout.left + layout.plotWidth + 8, y(tick) + 4.5));
    }
    if (zero && low !== 0) {
        const base = svgElement('line', 'tc-grid');
        setAttributes(base, { x1: layout.left, x2: layout.left + layout.plotWidth, y1: y(low), y2: y(low) });
        svg.append(base);
    }
    return y;
}
let measure;
/** Rendered width of a 13 px tick label; an estimate where the page cannot measure text. */
function tickWidth(label) {
    if (measure === undefined) {
        measure = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
        if (measure)
            measure.font = `13px ${getComputedStyle(document.documentElement).fontFamily}`;
    }
    return measure ? measure.measureText(label).width : label.length * 8.6;
}
function lineChart(svg, layout, points, { format, ratio, compact, tickUnit = 1, labelCurrent = true, secondary }) {
    const values = points.flatMap(point => point.value === null ? [] : [point.value]);
    // The second scale starts at zero and shares the main grid lines: each line carries one round value of each.
    const secondValues = secondary?.values.flatMap(value => value === null ? [] : [value]) ?? [];
    let secondHigh = 0;
    const rightLabels = secondary && secondValues.length ? (ticks) => {
        const unit = secondary.tickUnit ?? 1;
        const step = niceStep(Math.max(...secondValues, 0) / unit / Math.max(1, ticks - 1)) * unit;
        secondHigh = step * (ticks - 1);
        return Array.from({ length: ticks }, (_, index) => index === 0 ? '0' : secondary.format(step * index));
    } : undefined;
    const y = yAxis(svg, layout, values, ratio, compact ? 3 : 4, format, tickUnit, false, rightLabels);
    placeX(svg, layout, points);
    const x = (index) => layout.xs[index];
    markBoundaries(svg, layout, points);
    if (secondary && secondHigh > 0) {
        const y2 = (value) => layout.top + layout.plotHeight - value / secondHigh * layout.plotHeight;
        for (const segment of segments(secondary.values, points)) {
            const path = svgElement('path', 'tc-line tc-line-secondary');
            path.setAttribute('d', segment.map((index, order) => {
                const value = secondary.values[index];
                if (!order)
                    return `M${x(index).toFixed(1)},${y2(value).toFixed(1)}`;
                const last = order === segment.length - 1;
                return value === secondary.values[segment[order - 1]] && !last ? '' : `H${x(index).toFixed(1)}V${y2(value).toFixed(1)}`;
            }).join(''));
            svg.append(path);
        }
    }
    for (const segment of segments(points.map(point => point.value), points)) {
        const path = svgElement('path', 'tc-line');
        // Code keeps its state until the next commit, so the line holds each value and steps at the commit that changed it;
        // a slope would invent values for the days between commits.
        // A run of equal values is one horizontal stroke, so ten thousand quiet commits cost a single segment.
        path.setAttribute('d', segment.map((index, order) => {
            const value = points[index].value;
            if (!order)
                return `M${x(index).toFixed(1)},${y(value).toFixed(1)}`;
            const last = order === segment.length - 1;
            return value === points[segment[order - 1]].value && !last ? '' : `H${x(index).toFixed(1)}V${y(value).toFixed(1)}`;
        }).join(''));
        svg.append(path);
    }
    const lastIndex = points.length - 1;
    const axis = layout.top + layout.plotHeight;
    layout.ys = points.map(point => point.value === null ? null : y(point.value));
    // A dot per commit is noise once commits sit close together: the line carries the curve, and a dot marks only what
    // says something (the selected and the last commit, flags, and a measurement with no neighbour to draw a line to).
    // Hover and the keyboard move one dot along the line instead. Only a short, sparse series keeps a dot per commit.
    const sparse = points.length <= 12 && layout.xs.every((at, index) => index === 0 || at - layout.xs[index - 1] >= 24);
    const lonely = (index) => points[index - 1]?.value == null && points[index + 1]?.value == null;
    // One value is labelled: the selected commit's, or the last one when the selection is off the chart.
    const selectedIndex = points.findIndex(point => point.current && point.value !== null);
    const labelled = labelCurrent && selectedIndex >= 0 ? selectedIndex : lastIndex;
    for (const [index, point] of points.entries()) {
        const marked = sparse || point.current || Boolean(point.flag || point.boundary) || index === lastIndex || (point.value !== null && lonely(index));
        if (!marked)
            continue;
        const link = pointLink(point, index);
        if (point.value === null) {
            const gap = svgElement('line', 'tc-missing-mark');
            setAttributes(gap, { x1: x(index), x2: x(index), y1: axis - 7, y2: axis });
            link.append(gap);
        }
        else {
            const dot = svgElement('circle', point.current ? 'tc-dot tc-dot-current' : 'tc-dot');
            if (point.partial)
                dot.classList.add('tc-dot-partial');
            setAttributes(dot, { cx: x(index), cy: y(point.value), r: point.current ? 5 : 3.5 });
            if (point.flag)
                link.append(flagMark(point.flag, x(index), y(point.value)));
            link.append(dot);
            if (index === labelled) {
                // A flag on this point or one just beside it takes the space above, so the value moves left of the pole.
                // The label runs left from its anchor; it steps left of every flag it would cross, so it never covers one.
                const width = format(point.value).length * 7.2;
                const top = y(point.value) - 11;
                let anchor = x(index);
                let poles = [];
                for (let pass = 0; pass < 4; pass += 1) {
                    const left = anchor - width - 4;
                    const crossed = points.flatMap((other, at) => {
                        if (!other.flag || other.value === null)
                            return [];
                        const foot = y(other.value) - 4;
                        return x(at) >= left && x(at) <= anchor + 11 && top > foot - 22 && top - 14 < foot ? [x(at)] : [];
                    });
                    if (!crossed.length || Math.min(...crossed) - 7 >= anchor)
                        break;
                    poles = crossed;
                    anchor = Math.min(...crossed) - 7;
                }
                // A label pushed far from its point would sit on the line; it goes under the point instead, where a flag never is.
                const below = x(index) - anchor > 40 && y(point.value) + 22 <= axis;
                if (below)
                    anchor = x(index) + (index === lastIndex ? 4 : 0);
                const value = text(format(point.value), point.current ? 'tc-value tc-value-current' : 'tc-value', anchor, below ? y(point.value) + 21 : top);
                value.setAttribute('text-anchor', (poles.length && !below) || (index === lastIndex && points.length > 1) ? 'end' : 'middle');
                link.append(value);
            }
        }
        svg.append(link);
    }
}
function barChart(svg, layout, points, { format, compact, upIsWorse, tickUnit }) {
    svg.classList.add('tc-bars');
    const values = points.flatMap(point => point.value === null ? [] : [point.value]);
    const y = yAxis(svg, layout, values, false, compact ? 3 : 4, format, tickUnit ?? 1, true);
    placeX(svg, layout, points);
    markBoundaries(svg, layout, points);
    const x = (index) => layout.xs[index];
    const gap = (index) => Math.min(index > 0 ? x(index) - x(index - 1) : Infinity, index < points.length - 1 ? x(index + 1) - x(index) : Infinity);
    const valueWidth = (value) => format(value).length * 7.6;
    layout.ys = points.map(point => point.value === null ? null : y(point.value));
    // In a long history the zero line already says "no change" and "not measured"; only bars that moved are drawn.
    const dense = layout.xs.some((at, index) => index > 0 && at - layout.xs[index - 1] < 7);
    for (const [index, point] of points.entries()) {
        const link = pointLink(point, index);
        const room = gap(index);
        if (dense && !point.current && (point.value === null || point.value === 0)) {
            svg.append(link);
            continue;
        }
        const barWidth = Math.max(2, Math.min(28, Number.isFinite(room) ? room * .62 : 28));
        if (point.value === null) {
            const missing = svgElement('line', 'tc-missing-mark');
            setAttributes(missing, { x1: x(index), x2: x(index), y1: y(0) - 3.5, y2: y(0) + 3.5 });
            link.append(missing);
        }
        else if (point.value !== 0) {
            const worse = upIsWorse ? point.value > 0 : point.value < 0;
            const bar = svgElement('rect', `tc-bar ${worse ? 'tc-bar-worse' : 'tc-bar-better'}${point.current ? ' tc-bar-current' : ''}`);
            const top0 = Math.min(y(point.value), y(0));
            setAttributes(bar, { x: x(index) - barWidth / 2, y: top0, width: barWidth, height: Math.max(1, Math.abs(y(point.value) - y(0))) });
            link.append(bar);
            if (point.current || valueWidth(point.value) < room) {
                const above = point.value > 0;
                const label = text(format(point.value), point.current ? 'tc-value tc-value-current' : 'tc-value', x(index), above ? y(point.value) - 7 : y(point.value) + 16);
                label.setAttribute('text-anchor', 'middle');
                link.append(label);
            }
        }
        else {
            const flat = svgElement('line', 'tc-zero-mark');
            setAttributes(flat, { x1: x(index) - barWidth / 2, x2: x(index) + barWidth / 2, y1: y(0), y2: y(0) });
            link.append(flat);
        }
        svg.append(link);
    }
}
/** A tiny flag planted in the point: the pennant of the logo on a short pole, both in the flag's colour. */
function flagMark(kind, x, y) {
    const group = svgElement('g', `tc-flag tc-flag-${kind}`);
    const foot = y - 4;
    const head = foot - 12;
    const pole = svgElement('rect');
    setAttributes(pole, { x: x - .75, y: head, width: 1.5, height: foot - head });
    const pennant = svgElement('path');
    pennant.setAttribute('d', `M${(x + .75).toFixed(1)},${head.toFixed(1)}L${(x + 10).toFixed(1)},${(head - .4).toFixed(1)}L${(x + .75).toFixed(1)},${(head + 5.5).toFixed(1)}Z`);
    group.append(pole, pennant);
    return group;
}
function flagIcon(kind) {
    const icon = svgElement('svg', `tc-flag tc-flag-${kind}`);
    icon.setAttribute('viewBox', '0 -1 11 14');
    icon.setAttribute('aria-hidden', 'true');
    icon.append(flagMark(kind, 1, 16));
    return icon;
}
function pointLink(point, index) {
    const link = svgElement('a', 'tc-point');
    link.setAttribute('href', point.href);
    link.setAttribute('aria-label', point.title);
    link.dataset.index = String(index);
    if (point.current)
        link.setAttribute('aria-current', 'true');
    return link;
}
function card(point, brief) {
    // Each card opens its commit: in a cluster the card is how one of several commits at a point is picked.
    const entry = document.createElement(point.href ? 'a' : 'div');
    entry.className = 'tc-tip-entry';
    if (entry instanceof HTMLAnchorElement)
        entry.href = point.href;
    const heading = document.createElement('strong');
    heading.textContent = point.tip.heading;
    const commit = document.createElement('code');
    commit.textContent = point.tip.commit;
    const value = document.createElement('span');
    value.className = 'tc-tip-value';
    value.textContent = point.tip.value;
    if (point.tip.change && !(brief && point.tip.change.direction === 'same')) {
        const change = document.createElement('span');
        change.className = 'tc-tip-change';
        change.dataset.direction = point.tip.change.direction;
        change.textContent = point.tip.change.text;
        value.append(' ', change);
    }
    entry.append(heading, commit);
    if (point.tip.subject)
        entry.append(Object.assign(document.createElement('span'), { className: 'tc-tip-subject', textContent: point.tip.subject }));
    entry.append(value);
    if (point.flag) {
        const line = document.createElement('span');
        line.className = 'tc-tip-flag';
        line.append(flagIcon(point.flag), flagNotes[point.flag]);
        entry.append(line);
    }
    for (const note of point.tip.notes) {
        const line = document.createElement('span');
        line.className = 'tc-tip-note';
        line.textContent = note;
        entry.append(line);
    }
    return entry;
}
/** One hover card for the whole chart: the point nearest the pointer, or the focused one. */
function interact(svg, tip, layout, points) {
    if (points.length === 0)
        return;
    const guide = svgElement('line', 'tc-guide');
    guide.setAttribute('visibility', 'hidden');
    svg.insertBefore(guide, svg.firstChild);
    // One dot follows the pointer or the keyboard along the line, so the chart needs no element per commit.
    const pointer = svgElement('circle', 'tc-dot tc-hover-dot');
    pointer.setAttribute('r', '4.5');
    pointer.setAttribute('visibility', 'hidden');
    svg.append(pointer);
    let active = -1;
    let side = null;
    let pending;
    let lastX = 0;
    const nearest = (clientX) => {
        const box = svg.getBoundingClientRect();
        const px = (clientX - box.left) * (layout.width / Math.max(1, box.width));
        let best = 0;
        for (const [index, position] of layout.xs.entries()) {
            // Prefer the later point on ties, so the newest of a cluster is reachable.
            if (Math.abs(position - px) <= Math.abs(layout.xs[best] - px))
                best = index;
        }
        return best;
    };
    const show = (index) => {
        if (index === active)
            return;
        active = index;
        const point = points[index];
        const x = layout.xs[index];
        setAttributes(guide, { x1: x, x2: x, y1: layout.top - 6, y2: layout.top + layout.plotHeight });
        guide.setAttribute('visibility', 'visible');
        svg.querySelectorAll('.tc-point.is-active').forEach(node => node.classList.remove('is-active'));
        const own = svg.querySelector(`.tc-point[data-index="${index}"]`);
        own?.classList.add('is-active');
        const markY = layout.ys[index];
        if (markY == null || own?.querySelector('.tc-dot') || svg.classList.contains('tc-bars'))
            pointer.setAttribute('visibility', 'hidden');
        else {
            setAttributes(pointer, { cx: x, cy: markY });
            pointer.setAttribute('visibility', 'visible');
        }
        tip.replaceChildren();
        // Marks closer than a few pixels overlap, so the card lists every commit under the pointer, newest first.
        const cluster = points.flatMap((_, other) => Math.abs(layout.xs[other] - x) < 4 ? [other] : []).reverse();
        // The card scrolls, so a cluster lists its commits whole up to a bound a hand can still scroll through.
        const listed = 50;
        for (const member of cluster.slice(0, listed))
            tip.append(card(points[member], cluster.length > 1));
        if (cluster.length > listed) {
            const more = document.createElement('span');
            more.className = 'tc-tip-note';
            more.textContent = `${cluster.length - listed} more commits at this point`;
            tip.append(more);
        }
        tip.scrollTop = 0;
        // Only a card of several commits takes the pointer; a single card stays out of the way of scanning along the chart.
        tip.classList.toggle('tc-tip-held', cluster.length > 1);
        tip.hidden = false;
        const scale = svg.getBoundingClientRect().width / Math.max(1, layout.width) || 1;
        const width = tip.offsetWidth;
        const room = svg.clientWidth || layout.width;
        // The card keeps the side it opened on while it fits, so it does not jump across the pointer heading for it.
        const right = x * scale + 14;
        const leftSide = x * scale - 14 - width;
        side = side === 'left' && leftSide >= 0 ? 'left' : right + width <= room ? 'right' : 'left';
        tip.style.left = `${Math.max(0, side === 'right' ? right : leftSide)}px`;
        tip.style.top = `${Math.max(0, Math.min((markY ?? layout.top + layout.plotHeight) * scale - tip.offsetHeight / 2, layout.top * scale + layout.plotHeight * scale - tip.offsetHeight))}px`;
    };
    const hide = () => {
        clearTimeout(pending);
        side = null;
        active = -1;
        tip.hidden = true;
        guide.setAttribute('visibility', 'hidden');
        pointer.setAttribute('visibility', 'hidden');
        svg.querySelectorAll('.tc-point.is-active').forEach(node => node.classList.remove('is-active'));
    };
    // A pointer heading for the card may cross other commits on the way. While it moves towards the card, the switch
    // waits a moment; reaching the card keeps it, so its commits can be scrolled and picked.
    svg.addEventListener('pointermove', event => {
        const candidate = nearest(event.clientX);
        const dx = event.clientX - lastX;
        lastX = event.clientX;
        clearTimeout(pending);
        if (candidate === active)
            return;
        const box = tip.hidden || !tip.classList.contains('tc-tip-held') ? null : tip.getBoundingClientRect();
        const heading = box !== null && (side === 'right' ? dx > 0 && event.clientX < box.left : dx < 0 && event.clientX > box.right);
        if (heading)
            pending = setTimeout(() => show(candidate), 220);
        else
            show(candidate);
    });
    svg.addEventListener('pointerleave', event => {
        if (!tip.contains(event.relatedTarget))
            hide();
    });
    tip.addEventListener('pointerenter', () => clearTimeout(pending));
    tip.addEventListener('pointerleave', event => {
        if (!svg.contains(event.relatedTarget))
            hide();
    });
    svg.addEventListener('click', event => {
        if (event.target.closest('.tc-point'))
            return;
        const href = points[nearest(event.clientX)]?.href;
        if (href)
            location.assign(href);
    });
    svg.addEventListener('focusin', event => {
        const index = Number(event.target.closest('.tc-point')?.dataset.index);
        if (Number.isInteger(index))
            show(index);
    });
    svg.addEventListener('focusout', hide);
    // The chart itself takes focus: arrows step through commits, Home and End jump to the ends, Enter opens the commit.
    svg.tabIndex = 0;
    svg.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End Enter');
    svg.setAttribute('aria-label', `${points.length} ${points.length === 1 ? 'commit' : 'commits'}; arrow keys move between them, Enter opens one`);
    svg.addEventListener('focus', () => {
        const current = points.findIndex(point => point.current);
        show(current >= 0 ? current : points.length - 1);
    });
    svg.addEventListener('keydown', event => {
        const last = points.length - 1;
        const from = active < 0 ? last : active;
        const next = event.key === 'ArrowLeft' ? Math.max(0, from - 1) : event.key === 'ArrowRight' ? Math.min(last, from + 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
        if (next !== null) {
            event.preventDefault();
            active = -1;
            show(next);
        }
        else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            location.assign(points[active].href);
        }
    });
}
/** Runs of consecutive measured points, broken where a measurement is missing. */
function segments(values, points) {
    const result = [];
    let run = [];
    for (const [index, value] of values.entries()) {
        if (value === null || points[index]?.boundary === 'changed') {
            if (run.length)
                result.push(run);
            run = [];
        }
        if (value !== null)
            run.push(index);
    }
    if (run.length)
        result.push(run);
    return result.filter(segment => segment.length > 1);
}
function markBoundaries(svg, layout, points) {
    for (const [index, point] of points.entries()) {
        if (index === 0 || !point.boundary)
            continue;
        const x = layout.xs[index];
        const line = svgElement('line', `tc-profile-${point.boundary}`);
        setAttributes(line, { x1: x, x2: x, y1: layout.top, y2: layout.top + layout.plotHeight });
        svg.append(line);
    }
}
function paddedRange(values, ratio) {
    let low = Math.min(...values);
    let high = Math.max(...values);
    // A minimum visible range keeps noise flat: 2 percentage points for ratios, 10% of the value for counts.
    const minimum = ratio ? .02 : Math.max(Math.abs(high) * .1, 2);
    if (high - low < minimum) {
        const middle = (high + low) / 2;
        low = middle - minimum / 2;
        high = middle + minimum / 2;
    }
    const span = high - low;
    low -= span * .12;
    high += span * .12;
    if (Math.min(...values) >= 0)
        low = Math.max(0, low);
    if (ratio && Math.max(...values) <= 1)
        high = Math.min(1, high);
    return [low, high];
}
/** Evenly spaced round ticks that cover the data with a margin. */
/** A round step near the given one: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw) {
    if (!(raw > 0))
        return 1;
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}
export function niceTicks(values, ratio, count) {
    if (values.length === 0)
        return ratio ? [0, .5, 1] : [0, 1];
    const [low, high] = paddedRange(values, ratio);
    const raw = (high - low) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw) ?? raw;
    const integral = !ratio && values.every(Number.isInteger);
    const unit = integral ? Math.max(1, step) : step;
    const first = Math.floor(low / unit) * unit;
    const last = Math.ceil(high / unit) * unit;
    const ticks = [];
    for (let tick = first; tick <= last + unit / 2; tick += unit)
        ticks.push(Number(tick.toPrecision(12)));
    return ticks;
}
function text(content, className, x, y) {
    const node = svgElement('text', className);
    node.textContent = content;
    setAttributes(node, { x, y });
    return node;
}
function setAttributes(node, attributes) {
    for (const [name, value] of Object.entries(attributes))
        node.setAttribute(name, String(Number(value.toFixed(1))));
}
function svgElement(tag, className) {
    const node = document.createElementNS(svgNamespace, tag);
    if (className)
        node.setAttribute('class', className);
    return node;
}
