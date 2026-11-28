import { hash } from 'node:crypto';
import type { Tree, TreeCursor } from 'web-tree-sitter';
import type { Candidate, CloneSource } from '@repometry/core/internal/model/clone-source.js';
import { duplicationSettings as limits } from '@repometry/core/internal/profile/maintainability.js';
import type { Grammar } from './language.js';
import { lowerBound } from './source-lines.js';
import type { SourceLines, Span } from './source-lines.js';

export function scanClones(path: string, tree: Tree, source: SourceLines, grammar: Grammar, damaged?: (span: Span) => boolean) {
  const cursor = tree.walk();
  try {
    return new TokenScanner(cursor, source, grammar, damaged).scan(path);
  } finally {
    cursor.delete();
  }
}

class FingerprintInput {
  private bytes = Buffer.allocUnsafe(256);
  private readonly offsets = [0];

  append(spelling: string): void {
    const start = this.offsets.at(-1)!;
    // UTF-8 needs at most three bytes per UTF-16 code unit. Only measure near the buffer boundary.
    if (start + spelling.length * 3 > this.bytes.length) this.reserve(start, Buffer.byteLength(spelling));
    this.offsets.push(start + this.bytes.write(spelling, start));
  }

  private reserve(start: number, needed: number): void {
    if (start + needed <= this.bytes.length) return;
    const bytes = Buffer.allocUnsafe(Math.max(start + needed, this.bytes.length * 2));
    this.bytes.copy(bytes, 0, 0, start);
    this.bytes = bytes;
  }

  fingerprint(start: number, end: number): string {
    return hash('sha256', this.bytes.subarray(this.offsets[start], this.offsets[end]), 'base64url');
  }
}

class TokenScanner {
  private readonly comments: Span[] = [];
  private readonly ranges: Span[] = [];
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly exact = new FingerprintInput();
  private readonly similar = new FingerprintInput();
  private readonly collect: boolean;
  private candidateEnd = 0;

  constructor(private readonly cursor: TreeCursor, private readonly source: SourceLines, private readonly grammar: Grammar,
    private readonly damaged?: (span: Span) => boolean) {
    this.collect = source.count >= limits.minCodeLines;
  }

  scan(path: string) {
    do {
      if (this.read(this.cursor.nodeType)) continue;
      if (!this.advance()) break;
    } while (true);
    const lines = this.source.classify(this.comments);
    return { ...lines, clones: this.cloneSource(path, lines.codeLines) };
  }

  private advance(): boolean {
    while (!this.cursor.gotoNextSibling()) {
      if (!this.cursor.gotoParent()) return false;
    }
    return true;
  }

  private read(type: string): boolean {
    if (this.grammar.comments.has(type)) {
      this.comments.push(span(this.cursor));
      return false;
    }
    if (this.grammar.extras.has(type)) return false;
    if (this.collect && this.grammar.tokens.candidates.has(type)) this.candidate();
    const kind = this.collect ? this.grammar.tokens.kinds.get(type) : undefined;
    if (!kind && this.cursor.gotoFirstChild()) return true;
    if (this.candidateEnd) {
      const start = this.cursor.startIndex;
      if (start < this.candidateEnd) this.record(start, type, kind);
    }
    return false;
  }

  private candidate(): void {
    const range = span(this.cursor);
    if (this.damaged?.(range)) return;
    if (range.end - range.start < limits.minNodes) return;
    if (this.source.line(range.end - 1) - this.source.line(range.start) + 1 < limits.minCodeLines) return;
    // Only tokens inside ranges that could meet both minima can be part of a fingerprint.
    this.ranges.push(range);
    this.candidateEnd = Math.max(this.candidateEnd, range.end);
  }

  private record(start: number, type: string, literal: string | undefined): void {
    const end = this.cursor.endIndex;
    const value = this.source.text.slice(start, end);
    if (!value.trim()) return;
    const [spelling, kind] = this.grammar.tokens.normalize?.(type, value, literal) ?? [value, literal];
    // Each spelling is its UTF-16 length, a colon, then the text. A kind is !kind:.
    const exact = spelling.length + ':' + spelling;
    this.starts.push(start);
    this.ends.push(end);
    this.exact.append(exact);
    this.similar.append(kind === undefined ? exact : '!' + kind + ':');
  }

  private cloneSource(path: string, lines: readonly number[]): CloneSource {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const range of this.ranges) {
      const start = lowerBound(this.starts, range.start);
      const end = lowerBound(this.starts, range.end);
      const nodes = end - start; // Existing ranking field holds the significant token count.
      if (nodes < limits.minNodes) continue;
      const key = start + ':' + end;
      if (seen.has(key)) continue;
      seen.add(key);
      const span = { start: this.starts[start]!, end: this.ends[end - 1]! };
      const { line, endLine } = this.source.position(span);
      const codeLines = lowerBound(lines, endLine + 1) - lowerBound(lines, line);
      if (codeLines >= limits.minCodeLines) candidates.push({ ...span, line, endLine, nodes, codeLines,
        exact: this.exact.fingerprint(start, end), similar: this.similar.fingerprint(start, end) });
    }
    return { path, scheme: this.grammar.language.id + '-tokens/v1', codeLines: lines, candidates };
  }
}

function span({ startIndex: start, endIndex: end }: TreeCursor): Span {
  return { start, end };
}
