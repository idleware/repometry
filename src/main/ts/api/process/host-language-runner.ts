import { execFile, spawnSync } from 'node:child_process';
import { constants, mkdtempSync, rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { digest } from '../../core/model/snapshot.js';
import type { ToolInvocation, ToolResult } from '../../core/ports/tool-runner.js';
import { validateToolInvocation, writeToolSnapshot } from './tool-snapshot.js';
import { toolFailure } from './failure.js';

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

  private goCompiler?: Promise<GoCompiler>;

  constructor(private readonly path: string, private readonly script: string, private readonly goVersion?: string) {}

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
        return await runTool(invocation, binary!, [...args, this.script], cwd, env);
      }
      const deadline = performance.now() + invocation.timeoutMs;
      const parser = await withinDeadline(this.goParser(invocation, deadline), deadline);
      return await runTool({ ...invocation, timeoutMs: timeLeft(deadline) }, parser, [], cwd, env);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  private async goParser(invocation: ToolInvocation, deadline: number): Promise<string> {
    this.goCompiler ??= findGoCompiler(this.path, this.goVersion).catch(error => {
      this.goCompiler = undefined;
      throw error;
    });
    const [compiler, source] = await Promise.all([this.goCompiler, readFile(this.script)]);
    const key = JSON.stringify([compiler.binary, compiler.resolved, compiler.version, digest(source)]);
    const existing = goParsers.get(key);
    if (existing) return existing;
    const pending = compileGoParser(compiler.binary, this.path, source, invocation.maxOutputBytes, deadline).catch(error => {
      goParsers.delete(key);
      throw error;
    });
    goParsers.set(key, pending);
    return pending;
  }
}

interface GoCompiler {
  readonly binary: string;
  readonly resolved: string;
  readonly version: string;
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

async function findGoCompiler(path: string, version: string | undefined): Promise<GoCompiler> {
  const name = process.platform === 'win32' ? 'go.exe' : 'go';
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const binary = join(directory, name);
    let resolved: string;
    try {
      resolved = await realpath(binary);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, constants.X_OK);
    } catch {
      continue;
    }
    return { binary, resolved, version: version ?? await probeGoVersion(binary, path) };
  }
  throw new Error('Could not find the host Go compiler');
}

async function probeGoVersion(binary: string, path: string): Promise<string> {
  const home = goProcessHome();
  const result = await runTool({ timeoutMs: 5_000, maxOutputBytes: 4_096 }, binary, ['version'], home, toolEnvironment(path, home));
  const output = Buffer.from(result.stdout).toString().trim() || Buffer.from(result.stderr).toString().trim();
  if (result.exitCode !== 0 || !output) throw new Error(toolFailure('Could not determine the host Go version', result.stderr));
  return output.match(/\bgo(\d+(?:\.\d+)+(?:[a-z][\w.-]*)?)/i)?.[1] ?? output;
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

function toolEnvironment(PATH: string, HOME: string): NodeJS.ProcessEnv {
  return { PATH, HOME, GOCACHE: join(HOME, 'go-cache'), GOENV: 'off', GO111MODULE: 'off',
    GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0' };
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
