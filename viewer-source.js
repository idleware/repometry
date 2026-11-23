/**
 * Fills a locator's template. A path keeps its slashes under {path} and loses them under {path:component}, as the
 * GitLab API wants. A fragment that names {line} is dropped when there is no line, so the link opens the file.
 */
export function expandLocator(template, { revision, path, line }) {
    const hash = template.indexOf('#');
    const fragment = hash < 0 ? '' : template.slice(hash);
    const base = hash < 0 ? template : template.slice(0, hash);
    const kept = line === undefined && fragment.includes('{line}') ? '' : fragment;
    return (base + kept).replace(/\{(revision|path:component|path|line)\}/g, (_, name) => {
        switch (name) {
            case 'revision': return encodeURIComponent(revision);
            case 'path:component': return encodeURIComponent(path);
            case 'path': return path.split('/').map(encodeURIComponent).join('/');
            default: return String(line);
        }
    });
}
/** A locator the viewer can use: a fetch URL that is web or site-relative, and a page link only over http(s). */
export function sourceLocator(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const { provider, url, web } = value;
    if (typeof provider !== 'string' || typeof url !== 'string' || !url.includes('{path'))
        return undefined;
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url))
        return undefined;
    return { provider, url, ...(typeof web === 'string' && /^https?:\/\//i.test(web) ? { web } : {}) };
}
const providerNames = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea' };
let locator;
const requests = new Map();
/** The export's locator, from the summary; none means the report has no source navigation. */
export function useSources(value) {
    locator = value;
}
/**
 * The file's text at the commit, or null when it cannot be had: no locator, a private repository, a commit that was
 * never pushed, a network failure. Nothing is requested until a file or an excerpt opens; each URL is fetched once.
 */
export function loadSource(sha, path) {
    if (!locator)
        return Promise.resolve(null);
    const url = expandLocator(locator.url, { revision: sha, path });
    let request = requests.get(url);
    if (!request) {
        request = fetch(url).then(response => response.ok ? response.text() : null).catch(() => null);
        requests.set(url, request);
    }
    return request;
}
/** The page that shows the file on its forge, when the export names one. */
export function sourcePage(sha, path, line) {
    if (!locator?.web)
        return null;
    const name = providerNames[locator.provider.toLowerCase()] ?? locator.provider.charAt(0).toUpperCase() + locator.provider.slice(1);
    return { href: expandLocator(locator.web, { revision: sha, path, line }), provider: name };
}
export function isSourceLayer(value) {
    return value === 'issues' || value === 'coverage';
}
/**
 * Each line's coverage, by line number; a line no range names was not measured. Where ranges overlap, the worse
 * state wins: a line a test missed is never shown as covered.
 */
export function lineStates(coverage) {
    const states = new Map();
    const lay = (ranges, state) => {
        for (const [from, to] of ranges ?? [])
            for (let line = Math.max(1, from); line <= to; line++)
                states.set(line, state);
    };
    lay(coverage.covered, 'covered');
    lay(coverage.partial, 'partial');
    lay(coverage.uncovered, 'uncovered');
    return states;
}
/** How often tests ran each line, where the report carries the counts; an older report has none. */
export function lineHits(coverage) {
    const hits = new Map();
    for (const [from, to, count] of coverage.hits ?? [])
        for (let line = Math.max(1, from); line <= to; line++)
            hits.set(line, count);
    return hits;
}
// Two figures are enough for a glance; the tooltip has the whole count.
const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 2 });
const fullCount = new Intl.NumberFormat();
/** A count short enough for the gutter: 3×, 980×, 1.2K×, 45K×, 270K×, 3.4M×. */
export function hitLabel(count) {
    return `${count < 1000 ? count : compactCount.format(count)}×`;
}
/** What a measured line says to a pointer and a screen reader: its state, and how often it ran where that is known. */
export function lineCoverageText(state, count) {
    if (count === undefined || state === 'uncovered')
        return lineStateNames[state];
    return `${lineStateNames[state]}. Ran ${fullCount.format(count)} ${count === 1 ? 'time' : 'times'}`;
}
const lineStateNames = {
    covered: 'Covered', partial: 'Partly covered: some branches missed', uncovered: 'Not covered',
};
/** Switches a rendered source between its findings and its coverage, without drawing it again. */
export function setSourceLayer(container, layer) {
    const code = container.querySelector(':scope > .src');
    if (code)
        code.dataset.layer = layer;
}
/** The source as numbered lines; returns a function that brings a line into view and marks it. */
export function renderSource(container, text, options) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    // Tokenized up front, in order, since a comment's state carries from line to line.
    const tokenize = tokenizer(options.path);
    const tokens = lines.map(line => tokenize(line));
    const bridged = options.coverage ? bridgeStates(options.coverage, tokens.map(codeless)) : new Map();
    const starts = new Map(options.functions.map(entry => [entry.line, entry]));
    const notes = new Map();
    for (const note of options.notes)
        notes.set(note.line, [...notes.get(note.line) ?? [], note]);
    const code = element('div', 'src');
    code.dataset.layer = options.layer ?? 'issues';
    code.setAttribute('role', 'region');
    code.setAttribute('aria-label', `Source of ${options.path}`);
    const rows = [];
    const fragment = document.createDocumentFragment();
    for (const [index, line] of lines.entries()) {
        const number = index + 1;
        const row = element('div', 'src-line');
        row.id = `L${number}`;
        const mark = element('span', 'src-mark');
        const start = starts.get(number);
        if (start) {
            const badge = element('span', `src-complexity src-band-${start.complexity >= 20 ? 3 : start.complexity >= 10 ? 2 : start.complexity >= 5 ? 1 : 0}`, String(start.complexity));
            badge.title = `Cyclomatic complexity ${start.complexity}`;
            mark.append(badge);
        }
        // The coverage layer tints each measured line's gutter cell and writes in it how often the line ran; a miss's red says it.
        // Nothing runs on a blank or comment line: where a tool counts one anyway, or it sits inside a run of one state, it
        // keeps the strip's tint and says nothing.
        const runs = tokens[index];
        const own = options.coverage?.get(number);
        const state = own ?? bridged.get(number);
        if (state && (!own || codeless(runs))) {
            const cell = element('span', `src-cov src-cov-mark-${state}`);
            cell.setAttribute('aria-hidden', 'true');
            mark.append(cell);
        }
        else if (state) {
            const count = options.hits?.get(number);
            const cell = element('span', `src-cov src-cov-mark-${state}`, count === undefined || state === 'uncovered' ? '' : hitLabel(count));
            cell.setAttribute('role', 'img');
            cell.setAttribute('aria-label', lineCoverageText(state, count));
            cell.title = lineCoverageText(state, count);
            mark.append(cell);
        }
        const anchor = element('a', 'src-number', String(number));
        anchor.href = `#L${number}`;
        anchor.addEventListener('click', event => {
            event.preventDefault();
            reveal(number, false);
            options.choose(number);
        });
        const content = element('code', 'src-code');
        content.append(...runs.map(([kind, value]) => kind ? element('span', `tok-${kind}`, value) : document.createTextNode(value)));
        if (notes.has(number))
            row.classList.add('src-flagged');
        row.append(mark, anchor, content);
        fragment.append(row);
        rows.push(row);
        for (const note of notes.get(number) ?? []) {
            const box = element('div', `src-note src-note-${note.level}`);
            box.append(element('strong', '', note.title), element('span', '', note.message));
            fragment.append(box);
        }
    }
    code.append(fragment);
    container.replaceChildren(code);
    function reveal(line, scroll = true) {
        for (const row of code.querySelectorAll('.src-target'))
            row.classList.remove('src-target');
        const row = rows[line - 1];
        if (!row)
            return;
        row.classList.add('src-target');
        if (scroll)
            row.scrollIntoView({ block: 'center' });
    }
    if (options.line)
        requestAnimationFrame(() => reveal(options.line));
    return reveal;
}
/**
 * A few lines of source around a finding, bounded so a 160-line function stays a card: one line of context,
 * the head of the flagged range marked, then a link to the rest.
 */
export function renderExcerpt(text, options) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const end = Math.min(lines.length, Math.max(options.line, options.endLine ?? options.line));
    const from = Math.max(1, options.line - 1);
    const to = Math.min(end, from + (options.size ?? 6) - 1, lines.length);
    const highlight = highlighter(options.path);
    const box = element('div', 'src src-excerpt');
    for (const [index, line] of lines.entries()) {
        // Highlighting runs from the top so a comment or template opened above the excerpt keeps its colour.
        const nodes = highlight(line);
        const number = index + 1;
        if (number < from)
            continue;
        if (number > to)
            break;
        const row = element('div', number >= options.line && number <= end ? 'src-line src-range' : 'src-line');
        const code = element('code', 'src-code');
        code.append(...nodes);
        row.append(element('span', 'src-mark'), element('span', 'src-number', String(number)), code);
        box.append(row);
    }
    if (end > to) {
        const rest = element(options.more ? 'a' : 'span', 'src-more', `⋯ ${end - to} more ${end - to === 1 ? 'line' : 'lines'}, to line ${end}`);
        if (options.more && rest instanceof HTMLAnchorElement)
            rest.href = options.more(to + 1);
        box.append(rest);
    }
    return box;
}
/** The first code on a line, trimmed: a name for an anonymous function that says which one it is. */
export function lineSnippet(text, line, limit = 60) {
    const found = text.split('\n')[line - 1]?.trim();
    if (!found)
        return null;
    return found.length > limit ? `${found.slice(0, limit - 1)}…` : found;
}
/** A single line of code, coloured as the source view colours it; for a snippet that stands on its own. */
export function highlightCode(path, line) {
    return highlighter(path)(line);
}
const keywords = new Set(('abstract as async await break case catch class const continue debugger declare default delete do else enum export '
    + 'extends false finally for from function get if implements import in instanceof interface let new null of package private protected '
    + 'public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield').split(' '));
/** Words after which a slash opens a regular expression rather than divides. */
const beforeRegex = new Set('return typeof instanceof in of new delete void throw case do else yield await'.split(' '));
/**
 * Splits lines of JavaScript or TypeScript into coloured runs: comments, strings, regular expressions, numbers and
 * keywords. It is a scanner, not a parser, but it honours escapes and character classes, and it tells a regular
 * expression from a division by what comes before the slash. State carries across lines, so a block comment or a
 * template literal stays coloured to its end. Other languages come back as plain text.
 */
export function tokenizer(path) {
    if (!/\.(m|c)?[jt]sx?$/.test(path))
        return line => [['', line]];
    let open = '';
    let regexAllowed = true;
    return line => {
        const runs = [];
        let plain = '';
        const push = (kind, value) => {
            if (!value)
                return;
            if (!kind) {
                plain += value;
                return;
            }
            if (plain) {
                runs.push(['', plain]);
                plain = '';
            }
            runs.push([kind, value]);
        };
        // Past an escape: the index after the closing quote, or the line's end when it stays open.
        const close = (from, quote) => {
            let at = from;
            while (at < line.length && line[at] !== quote)
                at += line[at] === '\\' ? 2 : 1;
            return at < line.length ? [at + 1, true] : [line.length, false];
        };
        let at = 0;
        while (at < line.length) {
            if (open === 'comment') {
                const end = line.indexOf('*/', at);
                const stop = end < 0 ? line.length : end + 2;
                push('c', line.slice(at, stop));
                at = stop;
                if (end >= 0)
                    open = '';
                continue;
            }
            if (open === 'template') {
                const [stop, closed] = close(at, '`');
                push('s', line.slice(at, stop));
                at = stop;
                if (closed) {
                    open = '';
                    regexAllowed = false;
                }
                continue;
            }
            const char = line[at];
            const next = line[at + 1];
            if (char === '/' && next === '/') {
                push('c', line.slice(at));
                break;
            }
            if (char === '/' && next === '*') {
                push('c', '/*');
                at += 2;
                open = 'comment';
                continue;
            }
            if (char === '`') {
                push('s', '`');
                at += 1;
                open = 'template';
                continue;
            }
            if (char === '"' || char === "'") {
                const [stop] = close(at + 1, char);
                push('s', line.slice(at, stop));
                at = stop;
                regexAllowed = false;
                continue;
            }
            if (char === '/' && regexAllowed) {
                let end = at + 1;
                let inClass = false;
                while (end < line.length) {
                    const current = line[end];
                    if (current === '\\') {
                        end += 2;
                        continue;
                    }
                    if (inClass) {
                        if (current === ']')
                            inClass = false;
                    }
                    else if (current === '[')
                        inClass = true;
                    else if (current === '/')
                        break;
                    end += 1;
                }
                if (end < line.length) {
                    end += 1;
                    while (end < line.length && /[a-z]/i.test(line[end]))
                        end += 1;
                    push('s', line.slice(at, end));
                    at = end;
                    regexAllowed = false;
                    continue;
                }
            }
            const word = /^[A-Za-z_$][\w$]*/.exec(line.slice(at))?.[0];
            if (word) {
                push(keywords.has(word) ? 'k' : '', word);
                regexAllowed = beforeRegex.has(word);
                at += word.length;
                continue;
            }
            const number = /^(?:0x[\da-f_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?n?)/i.exec(line.slice(at))?.[0];
            if (number) {
                push('n', number);
                regexAllowed = false;
                at += number.length;
                continue;
            }
            push('', char);
            // After a closing bracket a slash divides; after any other punctuation it opens a regular expression.
            if (!/\s/.test(char))
                regexAllowed = char !== ')' && char !== ']';
            at += 1;
        }
        if (plain)
            runs.push(['', plain]);
        return runs;
    };
}
/**
 * The tint a gap of blank and comment lines takes so a run of one state stays one strip: the state of the measured
 * lines on both sides, where they agree. A gap between different states, or at the file's start or end, stays plain.
 */
export function bridgeStates(states, codeless) {
    const bridged = new Map();
    let line = 1;
    while (line <= codeless.length) {
        if (states.has(line) || !codeless[line - 1]) {
            line += 1;
            continue;
        }
        let end = line;
        while (end < codeless.length && !states.has(end + 1) && codeless[end])
            end += 1;
        const before = states.get(line - 1);
        if (before && before === states.get(end + 1))
            for (let at = line; at <= end; at++)
                bridged.set(at, before);
        line = end + 1;
    }
    return bridged;
}
/** A line with no code: blank, or nothing but comment. */
export function codeless(runs) {
    return runs.every(([kind, value]) => kind === 'c' || !value.trim());
}
function highlighter(path) {
    const tokenize = tokenizer(path);
    return line => tokenize(line).map(([kind, value]) => kind ? element('span', `tok-${kind}`, value) : document.createTextNode(value));
}
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
