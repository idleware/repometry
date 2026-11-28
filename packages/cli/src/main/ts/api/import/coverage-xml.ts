// The position of the offending character, the token's start by default, gives the reported line.
type Failure = (reason: string, position?: number) => never;

interface XmlVisitor {
  open(name: string, attributes: ReadonlyMap<string, string>, parents: readonly string[], line: number): void;
  close(name: string, parents: readonly string[]): void;
  text(value: string, parents: readonly string[]): void;
}

type Token =
  | { readonly kind: 'open'; readonly end: number; readonly name: string; readonly attributes: ReadonlyMap<string, string>; readonly empty: boolean }
  | { readonly kind: 'close'; readonly end: number; readonly name: string }
  | { readonly kind: 'text'; readonly end: number; readonly value: string }
  | { readonly kind: 'skip'; readonly end: number };

const entities = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);

export function readCoverageXml(input: string, invalid: (line: number, reason: string) => never, visitor: XmlVisitor): void {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const parents: string[] = [];
  let root = false;
  let line = 1;
  let offset = 0;
  const fail: Failure = (reason, position = offset) => invalid(line + text.slice(offset, position).split('\n').length - 1, reason);
  while (offset < text.length) {
    const token = readToken(text, offset, fail);
    if (token.kind === 'open') {
      if (parents.length === 0) {
        if (root || token.name !== 'coverage') invalid(line, 'expected a <coverage> root element');
        root = true;
      }
      visitor.open(token.name, token.attributes, parents, line);
      if (token.empty) visitor.close(token.name, parents);
      else parents.push(token.name);
    } else if (token.kind === 'close') {
      if (parents.pop() !== token.name) invalid(line, 'unexpected </' + token.name + '>');
      visitor.close(token.name, parents);
    } else if (token.kind === 'text') {
      if (!parents.length && token.value.trim()) fail('expected a <coverage> root element', offset + text.slice(offset).search(/\S/));
      visitor.text(token.value, parents);
    }
    for (; offset < token.end; offset++) if (text.charCodeAt(offset) === 10) line++;
  }
  if (parents.length) invalid(line, 'unclosed <' + parents.at(-1) + '>');
  if (!root) invalid(1, 'expected a <coverage> root element');
}

function readToken(text: string, offset: number, fail: Failure): Token {
  if (text[offset] !== '<') {
    const next = text.indexOf('<', offset);
    const end = next === -1 ? text.length : next;
    return { kind: 'text', end, value: decode(text.slice(offset, end), offset, fail) };
  }
  if (text.startsWith('<![CDATA[', offset)) {
    const end = sectionEnd(text, offset + 9, ']]>', fail);
    return { kind: 'text', end, value: text.slice(offset + 9, end - 3) };
  }
  if (text.startsWith('<!--', offset)) return { kind: 'skip', end: sectionEnd(text, offset + 4, '-->', fail) };
  if (text.startsWith('<?', offset)) return { kind: 'skip', end: sectionEnd(text, offset + 2, '?>', fail) };
  if (text.startsWith('<!DOCTYPE', offset)) return { kind: 'skip', end: doctypeEnd(text, offset, fail) };
  return readTag(text, offset, fail);
}

function sectionEnd(text: string, start: number, separator: string, fail: Failure): number {
  const end = text.indexOf(separator, start);
  if (end === -1) fail('malformed tag');
  return end + separator.length;
}

function doctypeEnd(text: string, offset: number, fail: Failure): number {
  const name = /<!DOCTYPE\s+[A-Za-z_:][\w:.-]*/y;
  name.lastIndex = offset;
  if (!name.test(text)) fail('malformed tag');
  // Quoted identifiers can contain brackets. Stop before reading any unquoted internal subset.
  for (let index = name.lastIndex; index < text.length; index++) {
    const char = text[index];
    if (char === '>') return index + 1;
    if (char === '[') fail('DOCTYPE with an internal subset is not supported', index);
    if (char === '"' || char === "'") index = text.indexOf(char, index + 1);
    if (index === -1) break;
  }
  return fail('malformed tag');
}

function readTag(text: string, offset: number, fail: Failure): Token {
  const tag = /<(\/?)([A-Za-z_:][\w:.-]*)/y;
  tag.lastIndex = offset;
  const match = tag.exec(text);
  if (!match) fail('malformed tag');
  const name = match[2]!;
  const ending = /\s*(\/?)>/y;
  if (match[1]) {
    ending.lastIndex = tag.lastIndex;
    const close = ending.exec(text);
    if (!close || close[1]) fail('malformed tag');
    return { kind: 'close', end: ending.lastIndex, name };
  }
  const attributes = new Map<string, string>();
  const attr = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  for (let end = tag.lastIndex;; end = attr.lastIndex) {
    ending.lastIndex = end;
    const edge = ending.exec(text);
    if (edge) return { kind: 'open', end: ending.lastIndex, name, attributes, empty: edge[1] === '/' };
    attr.lastIndex = end;
    const value = attr.exec(text);
    if (!value) fail('malformed attribute', end + text.slice(end).search(/\S/));
    const key = value[1]!;
    const raw = value[2] ?? value[3]!;
    if (attributes.has(key)) fail('duplicate attribute ' + key, end + value[0].search(/\S/));
    attributes.set(key, decode(raw, attr.lastIndex - raw.length - 1, fail));
  }
}

function decode(value: string, start: number, fail: Failure): string {
  return value.replace(/&(?:[^&;<\s]*;)?/g, (reference, index: number) => {
    const entity = reference.slice(1, -1);
    const named = entities.get(entity);
    if (named !== undefined) return named;
    const code = /^#x[\da-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!xmlCharacter(code)) fail('unknown entity ' + reference, start + index);
    return String.fromCodePoint(code);
  });
}

function xmlCharacter(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}
