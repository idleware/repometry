import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ToolInvocation, ToolResult } from '../../core/ports/tool-runner.js';
import { validateToolInvocation, writeToolSnapshot } from './tool-snapshot.js';

export function hostToolPath(): string {
  return (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);
}

export function hostToolVersion(binary: string, args: readonly string[], path: string): string | undefined {
  if (!path) return undefined;
  const home = mkdtempSync(join(tmpdir(), 'repometry-tool-version-'));
  try {
    const result = spawnSync(binary, args, { cwd: home, env: toolEnvironment(path, home), encoding: 'utf8',
      timeout: 5_000, maxBuffer: 4_096, killSignal: 'SIGKILL', windowsHide: true });
    return result.status === 0 ? (result.stdout.trim() || result.stderr.trim() || undefined) : undefined;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export class HostLanguageRunner {
  readonly implementation = 'host-language-runner/v1';

  constructor(private readonly path: string, private readonly script: string) {}

  async run(invocation: ToolInvocation): Promise<ToolResult> {
    validateToolInvocation(invocation);
    const home = await mkdtemp(join(tmpdir(), 'repometry-language-'));
    try {
      const cwd = join(home, 'snapshot');
      await mkdir(cwd);
      await writeToolSnapshot(cwd, invocation.files);
      return await runParser(invocation, this.script, cwd, toolEnvironment(this.path, home));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

function toolEnvironment(PATH: string, HOME: string): NodeJS.ProcessEnv {
  return { PATH, HOME, GOCACHE: join(HOME, 'go-cache'), GOENV: 'off', GO111MODULE: 'off',
    GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0' };
}

function runParser({ argv, stdin, timeoutMs, maxOutputBytes }: ToolInvocation, script: string, cwd: string,
  env: NodeJS.ProcessEnv): Promise<ToolResult> {
  const [binary, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = execFile(binary!, [...args, script], { cwd, env, timeout: timeoutMs, maxBuffer: maxOutputBytes,
      killSignal: 'SIGKILL', encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || stdout.length + stderr.length > maxOutputBytes) {
        reject(new Error('Tool exceeded the output limit'));
      } else if (error?.killed) {
        reject(new Error('Tool timed out'));
      } else if (error && typeof error.code !== 'number') {
        reject(new Error('Could not run the host language parser', { cause: error }));
      } else {
        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}
