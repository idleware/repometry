export interface Span {
  readonly start: number;
  readonly end: number;
}

export function lowerBound(values: readonly number[], value: number): number {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (values[middle]! < value) start = middle + 1;
    else end = middle;
  }
  return start;
}

export class SourceLines {
  readonly starts: number[] = [0];
  readonly count: number;

  constructor(readonly text: string, lineBreaks = /\r\n|[\n\r]/g) {
    for (const match of text.matchAll(lineBreaks)) this.starts.push(match.index + match[0].length);
    this.count = this.starts.length - Number(this.starts.at(-1) === text.length);
  }

  line(offset: number): number {
    return lowerBound(this.starts, offset + 1);
  }

  position(span: Span) {
    return { line: this.line(span.start), endLine: this.line(Math.max(span.start, span.end - 1)) };
  }

  column(offset: number, columns: 'bytes' | 'codepoints'): number {
    const prefix = this.text.slice(this.starts[this.line(offset) - 1], offset);
    return 1 + (columns === 'bytes' ? Buffer.byteLength(prefix) : [...prefix].length);
  }

  location(offset: number, columns: 'bytes' | 'codepoints'): string {
    const index = Math.min(offset, this.text.length);
    return 'line ' + this.line(index) + ', column ' + this.column(index, columns);
  }

  classify(comments: readonly Span[]) {
    const codeLines: number[] = [];
    let commentLines = 0;
    let next = 0;
    for (let row = 0; row < this.count; row++) {
      const start = this.starts[row]!;
      const end = this.starts[row + 1] ?? this.text.length;
      while (comments[next] && comments[next]!.end <= start) next++;
      const first = next;
      let offset = start;
      let code = false;
      for (let index = first; comments[index] && comments[index]!.start < end; index++) {
        const comment = comments[index]!;
        code ||= this.text.slice(offset, comment.start).trim() !== '';
        offset = comment.end;
      }
      if (code || this.text.slice(offset, end).trim()) codeLines.push(row + 1);
      else if (comments[first] && comments[first]!.start < end) commentLines++;
    }
    return { codeLines, commentLines };
  }
}
