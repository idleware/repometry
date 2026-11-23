import * as registry from './viewer-metric-registry.js';
/** One name per metric, for every page: Trends, the Overview figures, the Metrics and Issues summaries and columns. */
export const metricLabels = {
    coverage: 'Line coverage', lines: 'Physical lines', files: 'Analysed files', functions: 'Functions',
    complexity: 'Peak cyclomatic', cognitive: 'Cognitive complexity', duplication: 'Duplication',
    debt: 'Technical debt ratio', effort: 'Remediation time', smells: 'Code smells', 'code-lines': 'Code lines',
    classes: 'Classes', comments: 'Comment lines', security: 'Security findings',
    'coverable-lines': 'Measured lines', 'covered-lines': 'Covered lines', 'uncovered-lines': 'Uncovered lines',
    'security-high': 'High severity', 'security-medium': 'Medium severity', 'security-low': 'Low severity',
};
/**
 * Security is graded like the other areas, by the worst finding's risk: none A, low or unclassified B, medium C,
 * high D, critical F. The letter grades the repository; the words name the risk the findings carry, never a level of
 * security ("high risk" is not "high security").
 */
export const securityGrades = ['A', 'B', 'C', 'D', 'F'];
export const securityRisks = ['No findings', 'Low risk', 'Medium risk', 'High risk', 'Critical risk'];
export const metricDefinitions = {
    coverage: 'Share of measured lines executed by tests, read from LCOV.',
    lines: 'All lines in inspected source files, including blanks and comments.',
    files: 'Files in the inspection scope that a plugin analysed.',
    functions: 'Functions and methods found in inspected source files.',
    complexity: 'Highest cyclomatic complexity of any single function.',
    cognitive: 'Sum of cognitive complexity over all functions.',
    duplication: 'Share of code lines that belong to duplicated blocks.',
    debt: 'Estimated time to fix all code smells as a share of the estimated time to write the code (basic COCOMO).',
    effort: 'Estimated time to fix all code smells.',
    smells: 'Structural findings counted toward technical debt.',
    'code-lines': 'Lines of code, excluding blanks and comments.',
    classes: 'Classes found in inspected source files.',
    comments: 'Lines that contain only comments.',
    security: 'Findings from imported security scanners, all severities.',
    'coverable-lines': 'Lines the coverage report measured.',
    'covered-lines': 'Measured lines executed by tests.',
    'uncovered-lines': 'Measured lines no test executed.',
    'security-high': 'High-severity findings from imported security scanners.',
    'security-medium': 'Medium-severity findings from imported security scanners.',
    'security-low': 'Low-severity findings from imported security scanners.',
};
/** Metrics where a lower value is better. Coverage is better higher; the rest are neutral. */
const lowerIsBetter = new Set(['complexity', 'cognitive', 'duplication', 'debt', 'effort', 'smells', 'security',
    'uncovered-lines', 'security-high', 'security-medium', 'security-low']);
const integers = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
/**
 * The metrics other plugins declare, from the summary's catalog. Repometry's own metrics keep their typed fields and
 * hand-made surfaces, so a catalog that lists them changes nothing on screen.
 */
let plugins = [];
let pluginKeys = new Map();
let historyIndex = new Map();
export function useCatalog(catalog) {
    historyIndex = registry.catalogIndex(catalog);
    plugins = registry.metricSpecs(catalog ?? []).filter(spec => !registry.isBuiltin(spec.descriptor));
    pluginKeys = registry.byKey(plugins);
}
/** A detail's own catalog may name metrics the history does not, as when its inspection is newer than the summary. */
export function extendCatalog(catalog) {
    const known = new Set(plugins.map(spec => spec.descriptor.id));
    const added = (catalog ?? []).filter(descriptor => !registry.isBuiltin(descriptor) && !known.has(descriptor.id));
    if (!added.length)
        return;
    plugins = registry.metricSpecs([...plugins.map(spec => spec.descriptor), ...added]);
    pluginKeys = registry.byKey(plugins);
}
export function pluginMetrics() {
    return plugins;
}
export function pluginSpec(metric) {
    return metric in metricLabels ? undefined : pluginKeys.get(metric);
}
export function isMetric(value) {
    return value != null && (value in metricLabels || pluginKeys.has(value));
}
export function labelOf(metric) {
    return pluginSpec(metric)?.label ?? metricLabels[metric];
}
export function definitionOf(metric) {
    const spec = pluginSpec(metric);
    return spec ? spec.descriptor.description ?? '' : metricDefinitions[metric];
}
/** Which way is better: the green and red of changes and the flags on a chart follow it. */
export function betterOf(metric) {
    const spec = pluginSpec(metric);
    if (spec)
        return spec.descriptor.better;
    return lowerIsBetter.has(metric) ? 'lower' : metric === 'coverage' ? 'higher' : 'none';
}
export function metricValue(report, metric, quality, context) {
    const spec = pluginSpec(metric);
    if (spec)
        return registry.commitValue(historyIndex, report, spec);
    switch (metric) {
        case 'coverage': return report.lineCoverage && report.lineCoverage.total > 0 ? report.lineCoverage.covered / report.lineCoverage.total : null;
        case 'lines': return report.lines;
        case 'files': return report.files;
        case 'functions': return report.functions;
        case 'complexity': return report.maxComplexity;
        case 'cognitive': return quality?.cognitiveComplexity ?? null;
        case 'duplication': return quality?.duplication?.ratio ?? null;
        case 'debt': return quality?.maintainability?.debtRatio ?? null;
        case 'effort': return quality?.maintainability?.effortMinutes ?? null;
        case 'smells': return quality?.maintainability?.smells ?? null;
        case 'code-lines': return quality?.codeLines ?? null;
        case 'classes': return quality?.classes ?? null;
        case 'comments': return quality?.comments ?? null;
        case 'security': return context?.security ? Object.values(context.security).reduce((total, value) => total + value, 0) : null;
        case 'coverable-lines': return report.lineCoverage?.total ?? null;
        case 'covered-lines': return report.lineCoverage?.covered ?? null;
        case 'uncovered-lines': return report.lineCoverage ? report.lineCoverage.total - report.lineCoverage.covered : null;
        case 'security-high': return context?.security?.high ?? null;
        case 'security-medium': return context?.security?.medium ?? null;
        case 'security-low': return context?.security?.low ?? null;
    }
}
export function isPercent(metric) {
    const spec = pluginSpec(metric);
    if (spec)
        return spec.descriptor.unit === 'ratio';
    return metric === 'coverage' || metric === 'duplication' || metric === 'debt';
}
export function formatMetric(value, metric) {
    const spec = pluginSpec(metric);
    if (spec)
        return registry.format(spec, value);
    if (isPercent(metric))
        return percent.format(value);
    return metric === 'effort' ? duration(value) : count(value);
}
/** A size in bytes, in binary units named the way code hosts name them: 512 B, 4.8 KB, 340 KB, 1.2 MB. */
export function size(bytes) {
    if (bytes === null || bytes === undefined)
        return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // Below ten of a unit one decimal tells sizes apart; above it, whole units read faster.
    const shown = unit === 0 ? Math.round(value) : value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
    if (shown >= 1024 && unit < units.length - 1)
        return `1 ${units[unit + 1]}`;
    return `${shown.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
export function count(value) {
    return value === null ? '—' : integers.format(value);
}
export function duration(minutes) {
    const rounded = Math.round(minutes);
    if (rounded < 60)
        return `${count(rounded)} min`;
    const hours = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return rest ? `${count(hours)} h ${count(rest)} min` : `${count(hours)} h`;
}
/** Signed change between two values of one metric, in percentage points for ratios. */
export function difference(value, before, metric) {
    const spec = pluginSpec(metric);
    if (spec)
        return registry.difference(spec, value, before);
    const percentPoints = isPercent(metric);
    const raw = percentPoints ? (value - before) * 100 : value - before;
    const rounded = percentPoints ? Math.round(raw * 10) / 10 : Math.round(raw);
    if (rounded === 0)
        return { text: 'No change', direction: 'same' };
    const magnitude = percentPoints ? `${decimal.format(Math.abs(rounded))} pp` : metric === 'effort' ? duration(Math.abs(rounded)) : count(Math.abs(rounded));
    const better = lowerIsBetter.has(metric) ? rounded < 0 : metric === 'coverage' ? rounded > 0 : null;
    return { text: `${rounded > 0 ? '+' : '−'}${magnitude}`, direction: better === null ? 'neutral' : better ? 'better' : 'worse' };
}
