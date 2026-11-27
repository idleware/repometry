const aliases: Readonly<Record<string, string>> = { 'iso-latin-1': 'latin-1', 'latin-1-unix': 'latin-1',
  'utf-8-mac': 'utf-8', 'mac-roman': 'macintosh', big5hkscs: 'big5-hkscs' };

const cookie = /^[ \t\f]*#.*?coding[:=][ \t]*([-_.A-Za-z\d]+)/;

/** PEP 263 reads the first two physical lines as ASCII before choosing the Python source encoding. */
export function pythonSource(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const from = bom ? 3 : 0;
  const firstEnd = lineEnd(buffer, from);
  const first = buffer.toString('latin1', from, firstEnd);
  const secondStart = firstEnd + (buffer[firstEnd] === 13 && buffer[firstEnd + 1] === 10 ? 2 : 1);
  const second = /^[ \t\f]*(?:#|$)/.test(first) ? buffer.toString('latin1', secondStart, lineEnd(buffer, secondStart)) : '';
  const label = (cookie.exec(first)?.[1] ?? cookie.exec(second)?.[1] ?? 'utf-8').toLowerCase().replaceAll('_', '-');
  const encoding = aliases[label] ?? label;
  if (bom && !['utf-8', 'utf8', 'utf-8-sig'].includes(encoding)) throw new SyntaxError('UTF-8 signature disagrees with the encoding declaration');
  return decode(buffer, encoding);
}

function lineEnd(buffer: Buffer, start: number): number {
  for (let offset = start; offset < buffer.length; offset++) {
    if (buffer[offset] === 10 || buffer[offset] === 13) return offset;
  }
  return buffer.length;
}

function decode(buffer: Buffer, encoding: string): string {
  if (/^(?:latin-?1|iso-?8859-?1|latin)$/.test(encoding)) return buffer.toString('latin1');
  if (encoding === 'ascii' || encoding === 'us-ascii') {
    if (buffer.some(byte => byte > 127)) throw new SyntaxError('Non-ASCII bytes in an ASCII source file');
    return buffer.toString('ascii');
  }
  return new TextDecoder(encoding === 'utf-8-sig' ? 'utf-8' : encoding, { fatal: true }).decode(buffer);
}
