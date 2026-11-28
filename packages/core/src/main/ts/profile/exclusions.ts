import { posix } from 'node:path';

export const defaultSourceExclusions = [
  '**/.yarn', '**/.pnp.{js,cjs,loader.mjs}', '**/vendor', '**/third_party',
  '**/*.min.{js,cjs,mjs}', '**/*{.,-}bundle.{js,cjs,mjs}',
] as const;

export function sourceExclusionMatcher(patterns: readonly string[], generated: readonly string[] = []): (path: string) => boolean {
  const matches = exclusionMatcher([...defaultSourceExclusions, ...patterns]);
  const generatedPaths = new Set(generated);
  return path => generatedPaths.has(path) || matches(path);
}

export const generatedSourcePolicy = { version: 1, minBytes: 1024, minMeanLineLength: 300 } as const;

/** Detect generated text by its source-map trailer or the density of its nonblank lines. */
export function isGeneratedSource(bytes: Uint8Array): boolean {
  const source = new TextDecoder().decode(bytes);
  if (/(?:^|\n)[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=\S+|\/\*[#@][ \t]*sourceMappingURL=[^\r\n]+\*\/)[ \t\r\n]*$/.test(source)) return true;
  if (bytes.length < generatedSourcePolicy.minBytes) return false;
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/).map(line => line.trim()).filter(Boolean);
  return lines.reduce((sum, line) => sum + line.length, 0) > lines.length * generatedSourcePolicy.minMeanLineLength;
}

export function normalizeExclusions(value: unknown, field = 'Profile exclude'): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of repository-relative paths or globs`);
  const patterns = new Set<string>();
  for (const [index, item] of (value as unknown[]).entries()) {
    if (typeof item !== 'string') throw new Error(`${field}/${index} must be a string`);
    const pattern = item.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (!isRelativePath(pattern) || /[\\\0]/.test(pattern) || /^[#!]/.test(pattern)) {
      throw new Error(`${field}/${index} must be a repository-relative path or glob. Received ${JSON.stringify(item)}.`);
    }
    patterns.add(pattern);
  }
  return [...patterns];
}

export function exclusionMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return path => {
    if (!isRelativePath(path)) return false;
    // A rule that matches a directory excludes its entire subtree.
    let candidate = path;
    for (;;) {
      if (patterns.some(pattern => candidate === pattern || posix.matchesGlob(candidate, pattern))) return true;
      const slash = candidate.lastIndexOf('/');
      if (slash === -1) return false;
      candidate = candidate.slice(0, slash);
    }
  };
}

function isRelativePath(path: string): boolean {
  return !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
