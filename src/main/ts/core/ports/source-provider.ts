import type { Plugin } from '../engine/plugin.js';
import type { SourceLocator } from '../model/source-locator.js';

export interface SourceContext {
  readonly option?: string;
  readonly remotes: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SourceProvider {
  readonly id: string;
  locate(context: SourceContext): SourceLocator | undefined;
  read?(revision: string, path: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

export type SourcePlugin = Plugin & SourceProvider;

export function isSourcePathname(path: string): boolean {
  return !/^[A-Za-z]:/.test(path) && !/[\\\0\r\n]/.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
