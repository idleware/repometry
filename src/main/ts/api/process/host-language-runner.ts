import { execFile } from 'node:child_process';
import { constants, mkdtempSync, rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../core/model/snapshot.js';
import type { ToolInvocation, ToolResult } from '../../core/ports/tool-runner.js';
import { validateToolInvocation, writeToolSnapshot } from './tool-snapshot.js';
import { toolFailure } from './failure.js';
import { cacheRoot } from '../cache/root.js';
import { cachedGoParser } from './go-parser-cache.js';
import { toolEnvironment } from './host-tool.js';
import type { VersionedHostTool } from './host-tool.js';

export class HostLanguageRunner {
  readonly implementation = 'host-language-runner/v1';

  constructor(private readonly path: string, private readonly script: string, private readonly tool: VersionedHostTool) {}

  async run(invocation: ToolInvocation): Promise<ToolResult> {
    validateToolInvocation(invocation);
    const home = await mkdtemp(join(tmpdir(), 'repometry-language-'));
    try {
      const cwd = join(home, 'snapshot');
      await mkdir(cwd);
      await writeToolSnapshot(cwd, invocation.files);
      const env = toolEnvironment(this.path, home);
      const [binary, ...args] = invocation.argv;
      if (binary !== 'go' || args.length !== 1 || args[0] !== 'run') {
        return await runTool(invocation, this.tool.binary, [...args, this.script], cwd, env);
      }
      const deadline = performance.now() + invocation.timeoutMs;
      const parser = await withinDeadline(this.goParser(invocation, deadline), deadline);
      return await runTool({ ...invocation, timeoutMs: timeLeft(deadline) }, parser, [], cwd, env);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  private async goParser(invocation: ToolInvocation, deadline: number): Promise<string> {
    const compiler = this.tool;
    const source = await readFile(this.script);
    const key = digest(JSON.stringify([process.platform, process.arch, compiler, digest(source)]));
    const root = cacheRoot();
    const processKey = JSON.stringify([root, key]);
    const existing = goParsers.get(processKey);
    if (existing) return existing;
    const pending = cachedGoParser(key, deadline,
      () => compileGoParser(compiler.binary, this.path, source, invocation.maxOutputBytes, deadline), root).catch(error => {
      goParsers.delete(processKey);
      throw error;
    });
    goParsers.set(processKey, pending);
    return pending;
  }
}

const goParsers = new Map<string, Promise<string>>();
let goHome: string | undefined;

function goProcessHome(): string {
  if (goHome !== undefined) return goHome;
  const home = mkdtempSync(join(tmpdir(), 'repometry-go-parser-'));
  goHome = home;
  process.once('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch { /* Cleanup must not change the process exit status. */ }
  });
  return home;
}

async function compileGoParser(binary: string, path: string, source: Uint8Array, maxOutputBytes: number, deadline: number): Promise<string> {
  const home = goProcessHome();
  const directory = await mkdtemp(join(home, 'build-'));
  const script = join(directory, 'parser.go');
  const parser = join(directory, process.platform === 'win32' ? 'parser.exe' : 'parser');
  try {
    await writeFile(script, source, { mode: 0o600, flag: 'wx' });
    const result = await runTool({ timeoutMs: timeLeft(deadline), maxOutputBytes }, binary, ['build', '-o', parser, script],
      directory, toolEnvironment(path, home));
    if (result.exitCode !== 0) throw new Error(toolFailure('Could not compile the host Go parser', result.stderr));
    await access(parser, constants.X_OK);
    return parser;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function timeLeft(deadline: number): number {
  const timeout = Math.ceil(deadline - performance.now());
  if (timeout <= 0) throw new Error('Tool timed out');
  return timeout;
}

async function withinDeadline<T>(result: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiration = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tool timed out')), timeLeft(deadline));
    });
    return await Promise.race([result, expiration]);
  } finally {
    clearTimeout(timer);
  }
}

function runTool({ stdin, timeoutMs, maxOutputBytes }: Pick<ToolInvocation, 'stdin' | 'timeoutMs' | 'maxOutputBytes'>,
  binary: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd, env, timeout: timeoutMs, maxBuffer: maxOutputBytes,
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
