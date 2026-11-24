/**
 * Dependency lockfiles, by exact file name. They are generated, often the largest files in a repository, and no
 * plugin reads them: the language bar and the Metrics list give them a category of their own beside the ignored files.
 */
export const lockfileNames = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'flake.lock',
    'mix.lock', 'pubspec.lock', 'packages.lock.json', 'gradle.lockfile',
]);
/** Whether a path names a lockfile: its file name, at any depth, exactly as the tools write it. */
export function isLockfile(path) {
    return lockfileNames.has(path.slice(path.lastIndexOf('/') + 1));
}
/** Whether no plugin read a file and it is not a lockfile: what the interface calls ignored. */
export function isIgnored(entry) {
    return entry.analysed === false && !isLockfile(entry.path);
}
/** The language bar's names for the two categories that are not languages. */
export const lockfilesLabel = 'Lockfiles';
export const ignoredLabel = 'Ignored';
/** Whether every file carries its size: inspections made before sizes were recorded carry none. */
export function sized(files) {
    return files.length > 0 && files.every(entry => entry.bytes !== undefined);
}
const weights = {
    bytes: entry => entry.bytes,
    lines: entry => entry.lines,
    'code-lines': entry => entry.quality?.codeLines ?? entry.lines,
};
/**
 * Size in bytes when every file has it: one measure for code, lockfiles and ignored files alike, untouched by
 * formatting. Without sizes, physical lines where any file is only counted (the one line measure all files have),
 * otherwise code lines.
 */
function shareMeasure(files) {
    if (sized(files))
        return 'bytes';
    return files.some(entry => entry.analysed === false || isLockfile(entry.path)) ? 'lines' : 'code-lines';
}
/** Where a file's weight goes on the bar: its language, or one of the two categories. */
function shareOf(entry) {
    if (isLockfile(entry.path))
        return lockfilesLabel;
    return entry.analysed === false ? ignoredLabel : languageOf(entry.path);
}
/** What the language bar weighs, largest language first, then lockfiles, then the ignored files. */
export function languageShares(files) {
    const measure = shareMeasure(files);
    const totals = new Map();
    for (const entry of files)
        totals.set(shareOf(entry), (totals.get(shareOf(entry)) ?? 0) + (weights[measure](entry) ?? 0));
    const categories = [lockfilesLabel, ignoredLabel];
    const shares = [...totals].filter(([name, weight]) => weight > 0 && !categories.includes(name)).sort((a, b) => b[1] - a[1]);
    for (const name of categories) {
        const weight = totals.get(name) ?? 0;
        if (weight > 0)
            shares.push([name, weight]);
    }
    return { measure, shares };
}
const languages = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#',
    c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', swift: 'Swift', scala: 'Scala',
    vue: 'Vue', svelte: 'Svelte', sh: 'Shell', bash: 'Shell', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML',
    yaml: 'YAML', yml: 'YAML', json: 'JSON', dockerfile: 'Dockerfile',
};
/** Files a name alone types: Dockerfile and Containerfile, with or without a suffix such as Dockerfile.dev. */
const namedLanguages = [[/^(?:dockerfile|containerfile)(?:\..+)?$/i, 'Dockerfile']];
/** Language colours follow the conventions people already know from code hosts. */
const languageColors = {
    TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572a5', Go: '#00add8', Rust: '#dea584', Java: '#b07219',
    Kotlin: '#a97bff', Ruby: '#701516', PHP: '#4f5d95', 'C#': '#178600', C: '#555555', 'C++': '#f34b7d', Swift: '#f05138',
    Scala: '#c22d40', Vue: '#41b883', Svelte: '#ff3e00', Shell: '#89e051', CSS: '#663399', SCSS: '#c6538c', Less: '#1d365d',
    HTML: '#e34c26',
    // Configuration reads beside the code, so it takes quieter tones than the code hosts give it.
    YAML: '#c47d84', JSON: '#9b86b5', Dockerfile: '#4f9a94',
};
export function languageOf(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const named = namedLanguages.find(([pattern]) => pattern.test(name));
    if (named)
        return named[1];
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!extension)
        return 'Other';
    return languages[extension] ?? extension.toUpperCase();
}
export function languageColor(language) {
    return languageColors[language] ?? 'var(--neutral-2)';
}
