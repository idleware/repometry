import { unpackJson } from './compact-json.js';
import { summarySchema } from './summary-model.js';
import { compareHistoryEntries, historySchema } from './public-history-model.js';
import { sourceLocator } from './viewer-source.js';
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export class ViewerSummaryChanged extends Error {
    constructor() {
        super('The repository summary changed');
        this.name = 'ViewerSummaryChanged';
    }
}
export async function loadViewerData(mode) {
    const summary = await readSummary();
    if (!summary)
        return legacyViewerData(mode);
    const counts = Object.fromEntries(summary.commits.map(commit => [commit.sha, commit.counts]));
    const details = new Map(summary.commits.map(commit => [commit.sha, commit.detail]));
    return {
        reports: summary.commits,
        quality: Object.fromEntries(summary.commits.map(commit => [commit.sha, commit.quality])),
        context: Object.fromEntries(summary.commits.map(commit => [commit.sha, {
                exclusions: null, boundary: commit.profileBoundary ?? null, security: commit.counts?.security,
            }])),
        counts: mode === 'public' ? undefined : counts,
        pullReviewCount: summary.pullReviewCount,
        ...(Array.isArray(summary.metrics) ? { metrics: summary.metrics } : {}),
        ...(() => {
            const sources = mode === 'public' ? undefined : sourceLocator(summary.sources);
            return sources ? { sources } : {};
        })(),
        ...(typeof summary.source?.branch === 'string' && summary.source.branch.trim() ? { branch: summary.source.branch.trim() } : {}),
        async loadDetails(sha) {
            const path = details.get(sha);
            if (path === undefined || (mode !== 'local' && mode !== 'private'))
                return null;
            const asset = await readInspection(path, sha, mode);
            if (asset)
                return asset;
            const next = await readSummary('reload').catch(() => null);
            if (!next)
                return null;
            if (next.commits.find(commit => commit.sha === sha)?.detail !== path)
                throw new ViewerSummaryChanged();
            return readInspection(path, sha, mode);
        },
    };
}
async function readSummary(cache) {
    const response = await fetch('./summary.json', { cache });
    if (response.status === 404)
        return null;
    if (!response.ok)
        throw new Error('Could not load the repository summary');
    const data = await response.json();
    if (data?.schema !== summarySchema || !Array.isArray(data.commits)
        || data.commits.some(commit => !shaPattern.test(commit.sha) || !commit.quality))
        throw new Error('Unsupported repository summary');
    return data;
}
async function readInspection(path, sha, mode) {
    const prefix = `${mode === 'local' ? 'inspection' : 'details'}/${sha}-`;
    const allowed = path.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(path.slice(prefix.length));
    if (!allowed)
        return null;
    try {
        const asset = unpackJson(await readOptional(`./${path}`));
        return asset?.schema === 'urn:repometry:schema:viewer-inspection:1' && asset.sha === sha ? asset : null;
    }
    catch {
        return null;
    }
}
async function legacyViewerData(mode) {
    const [history, quality, saved, localContext] = await Promise.all([
        readOptional('./history.json'),
        readOptional('./quality-history.json'),
        mode === 'private' ? readOptional('./details.json') : null,
        mode === 'local' ? readOptional('./inspection-context.json') : null,
    ]);
    if (history?.schema !== historySchema || !Array.isArray(history.reports))
        throw new Error('Unsupported history format');
    const bundle = saved?.schema === 'urn:repometry:schema:viewer-details:1' ? saved : null;
    const context = localContext ?? bundle?.context ?? {};
    const reports = [...history.reports].sort(compareHistoryEntries);
    return {
        reports, context, quality: quality?.schema === 'urn:repometry:schema:quality-history:1' ? quality.reports : {},
        async loadDetails(sha) {
            if (!shaPattern.test(sha))
                return null;
            const inspection = mode === 'local'
                ? await readOptional(`./details/${sha}.json`)
                : bundle?.inspections[sha];
            return inspection ? { schema: 'urn:repometry:schema:viewer-inspection:1', sha, context: context[sha], inspection } : null;
        },
    };
}
async function readOptional(path) {
    try {
        const response = await fetch(path);
        return response.ok ? await response.json() : null;
    }
    catch {
        return null;
    }
}
