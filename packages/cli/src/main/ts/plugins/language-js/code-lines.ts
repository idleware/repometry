import type { File } from '@babel/types';

export interface CodeLineCounts {
  readonly code: readonly number[];
  readonly comments: number;
}

export function classifyLines(source: string, ast: File, physical: number): CodeLineCounts {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
  const masks = new Map<number, { start: number; end: number }[]>();
  for (const { loc } of [...(ast.program.interpreter ? [ast.program.interpreter] : []), ...ast.comments ?? []]) {
    if (!loc) continue;
    for (let line = loc.start.line; line <= loc.end.line && line <= physical; line++) {
      const start = line === loc.start.line ? loc.start.column : 0;
      const end = line === loc.end.line ? loc.end.column : lines[line - 1]!.length;
      const mask = { start, end };
      const intervals = masks.get(line);
      if (intervals) intervals.push(mask);
      else masks.set(line, [mask]);
    }
  }
  const code: number[] = [];
  let comments = 0;
  for (let line = 1; line <= physical; line++) {
    const text = lines[line - 1]!;
    const intervals = masks.get(line) ?? [];
    let offset = 0;
    let hasCode = false;
    for (const { start, end } of intervals) {
      hasCode ||= text.slice(offset, start).trim() !== '';
      offset = end;
    }
    if (hasCode || text.slice(offset).trim() !== '') code.push(line);
    else if (intervals.length > 0) comments++;
  }
  return { code, comments };
}
