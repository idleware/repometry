import { hash } from 'node:crypto';
import type { Tree, TreeCursor } from 'web-tree-sitter';
import type { Candidate, CloneSource } from '../../core/model/clone-source.js';
import { duplicationSettings as limits } from '../../core/profile/maintainability.js';
import type { Grammar } from './language.js';
import { lowerBound } from './source-lines.js';
import type { SourceLines, Span } from './source-lines.js';

interface Token extends Span {
  readonly exact: string;
  readonly similar: string;
}

interface ScannedTokens {
  readonly comments: Span[];
  readonly ranges: Span[];
  readonly tokens: Token[];
}

type Tokenized = Pick<ScannedTokens, 'ranges' | 'tokens'> & ReturnType<SourceLines['classify']>;

export function scanTokens(tree: Tree, source: SourceLines, grammar: Grammar): Tokenized {
  const cursor = tree.walk();
  try {
    const { comments, ranges, tokens } = new TokenScanner(cursor, source, grammar).scan();
    const lines = source.classify(comments);
    return lines.codeLines.length < limits.minCodeLines ? { ...lines, ranges: [], tokens: [] } : { ...lines, ranges, tokens };
  } finally {
    cursor.delete();
  }
}

class TokenScanner {
  private readonly result: ScannedTokens = { comments: [], ranges: [], tokens: [] };
  private readonly collect: boolean;

  constructor(private readonly cursor: TreeCursor, private readonly source: SourceLines, private readonly grammar: Grammar) {
    this.collect = source.count >= limits.minCodeLines;
  }

  scan(): ScannedTokens {
    do {
      if (this.read(this.cursor.nodeType)) continue;
      if (!this.advance()) return this.result;
    } while (true);
  }

  private advance(): boolean {
    while (!this.cursor.gotoNextSibling()) {
      if (!this.cursor.gotoParent()) return false;
    }
    return true;
  }

  private read(type: string): boolean {
    if (this.grammar.comments.has(type)) {
      this.result.comments.push(span(this.cursor));
      return false;
    }
    if (this.grammar.extras.has(type)) return false;
    // Every declaration, statement and block named by the language table is eligible, except imports.
    if (this.collect && this.grammar.tokens.candidates.has(type)) this.result.ranges.push(span(this.cursor));
    const kind = this.collect ? this.grammar.tokens.kinds.get(type) : undefined;
    if (!kind && this.cursor.gotoFirstChild()) return true;
    if (this.collect) this.record(type, kind);
    return false;
  }

  private record(type: string, literal: string | undefined): void {
    const { start, end } = span(this.cursor);
    const value = this.source.text.slice(start, end);
    if (!value.trim()) return;
    const [spelling, kind] = this.grammar.tokens.normalize?.(type, value, literal) ?? [value, literal];
    // Each spelling is its UTF-16 length, a colon, then the text. A kind is !kind:.
    const exact = spelling.length + ':' + spelling;
    this.result.tokens.push({ start, end, exact, similar: kind === undefined ? exact : '!' + kind + ':' });
  }
}

function span({ startIndex: start, endIndex: end }: TreeCursor): Span {
  return { start, end };
}

function fingerprintBuffer(tokens: readonly Token[], field: 'exact' | 'similar') {
  const starts = [0];
  const segments = tokens.map(token => {
    const segment = token[field];
    starts.push(starts.at(-1)! + segment.length);
    return segment;
  });
  const text = segments.join('');
  return (start: number, end: number) => hash('sha256', text.slice(starts[start], starts[end]), 'base64url');
}

export function cloneSource(path: string, scanned: Tokenized, source: SourceLines, grammar: Grammar): CloneSource {
  const candidates: Candidate[] = [];
  const { tokens, ranges, codeLines: lines } = scanned;
  const offsets = tokens.map(({ start }) => start);
  const exact = fingerprintBuffer(tokens, 'exact');
  const similar = fingerprintBuffer(tokens, 'similar');
  const seen = new Set<string>();
  for (const range of ranges) {
    const start = lowerBound(offsets, range.start);
    const end = lowerBound(offsets, range.end);
    const nodes = end - start; // Existing ranking field holds the significant token count in the token scheme.
    if (nodes < limits.minNodes) continue;
    const key = start + ':' + end;
    if (seen.has(key)) continue;
    seen.add(key);
    const span = { start: tokens[start]!.start, end: tokens[end - 1]!.end };
    const { line, endLine } = source.position(span);
    const codeLines = lowerBound(lines, endLine + 1) - lowerBound(lines, line);
    if (codeLines >= limits.minCodeLines) candidates.push({ ...span, line, endLine, nodes, codeLines, exact: exact(start, end), similar: similar(start, end) });
  }
  return { path, scheme: grammar.language.id + '-tokens/v1', codeLines: lines, candidates };
}
