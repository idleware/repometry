import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSourcePathname } from '../../core/ports/source-provider.js';
import type { ToolInvocation } from '../../core/ports/tool-runner.js';

export function validateToolInvocation(invocation: ToolInvocation): void {
  if (!invocation.argv[0] || invocation.argv.some(arg => arg.includes('\0'))) throw new Error('A tool command and valid arguments are required');
  if (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs < 1 || invocation.timeoutMs > 2_147_483_647) {
    throw new Error('Invalid tool timeout');
  }
  if (!Number.isSafeInteger(invocation.maxOutputBytes) || invocation.maxOutputBytes < 1) throw new Error('Invalid tool output limit');
  const paths = new Set<string>();
  for (const { path } of invocation.files) {
    if (!isSourcePathname(path) || paths.has(path)) throw new Error(`Invalid or duplicate snapshot path: ${path}`);
    paths.add(path);
  }
}

export async function writeToolSnapshot(directory: string, files: ToolInvocation['files']): Promise<void> {
  for (const file of files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' });
  }
}
