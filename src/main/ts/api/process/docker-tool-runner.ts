import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isSourcePathname } from '../../core/ports/source-provider.js';
import type { ToolInvocation, ToolResult, ToolRunner } from '../../core/ports/tool-runner.js';
import { toolFailure } from './failure.js';

const docker = promisify(execFile);
const proxyOverrides = ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'ALL_PROXY', 'NO_PROXY']
  .flatMap(name => ['--env', `${name}=`, '--env', `${name.toLowerCase()}=`]);

export interface DockerToolLimits {
  readonly memoryBytes?: number;
  readonly pidsLimit?: number;
}

export class DockerToolRunner implements ToolRunner {
  readonly network = 'none';
  readonly implementation: string;
  private readonly limits: readonly string[];

  constructor(private readonly image: string, { memoryBytes, pidsLimit }: DockerToolLimits = {}) {
    if (!image || /[\s\0]/.test(image)) throw new Error('A locally available Docker image is required');
    if ([memoryBytes, pidsLimit].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
      throw new Error('Docker memory and process limits must be positive integers');
    }
    this.limits = [...(memoryBytes === undefined ? [] : ['--memory', String(memoryBytes)]),
      ...(pidsLimit === undefined ? [] : ['--pids-limit', String(pidsLimit)])];
    this.implementation = JSON.stringify(['docker-tool-runner/v2', image, this.limits]);
  }

  async run(invocation: ToolInvocation): Promise<ToolResult> {
    const [command, ...args] = invocation.argv;
    if (!command || invocation.argv.some(arg => arg.includes('\0'))) throw new Error('A tool command and valid arguments are required');
    if (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs < 1 || invocation.timeoutMs > 2_147_483_647) {
      throw new Error('Invalid tool timeout');
    }
    if (!Number.isSafeInteger(invocation.maxOutputBytes) || invocation.maxOutputBytes < 1) throw new Error('Invalid tool output limit');
    const paths = new Set<string>();
    for (const { path } of invocation.files) {
      if (!isSourcePathname(path) || paths.has(path)) throw new Error(`Invalid or duplicate snapshot path: ${path}`);
      paths.add(path);
    }

    const directory = await mkdtemp(join(tmpdir(), 'repometry-tool-'));
    const container = `repometry-tool-${randomUUID()}`;
    try {
      for (const file of invocation.files) {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' });
      }
      const mount = `type=bind,"source=${directory.replaceAll('"', '""')}",target=/snapshot,readonly`;
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      const user = uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`];
      let result: ToolResult;
      try {
        result = await runTool([
          'run', '--rm', '--name', container, '--interactive', '--pull', 'never', '--network', 'none', '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev', '--env', 'HOME=/tmp',
          ...this.limits, ...user, ...proxyOverrides,
          '--mount', mount, '--workdir', '/snapshot', '--entrypoint', command, '--', this.image, ...args,
        ], invocation);
      } catch (error) {
        await removeContainer(container);
        throw error;
      }
      if ([125, 126, 127].includes(result.exitCode)) {
        throw new Error(toolFailure(`Docker could not start the tool (exit code ${result.exitCode})`, result.stderr));
      }
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function runTool(args: readonly string[], { stdin, timeoutMs, maxOutputBytes }: ToolInvocation): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { encoding: 'buffer', timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || stdout.length + stderr.length > maxOutputBytes) {
          reject(new Error('Tool exceeded the output limit'));
        } else if (error?.killed) {
          reject(new Error('Tool timed out'));
        } else if (error && typeof error.code !== 'number') {
          reject(new Error('Could not run the Docker tool', { cause: error }));
        } else {
          resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
        }
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

async function removeContainer(container: string): Promise<void> {
  try {
    await docker('docker', ['rm', '-f', '-v', container], { timeout: 5_000, maxBuffer: 16_384 });
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('No such container')) return;
    throw new Error('Could not confirm Docker tool cleanup', { cause: error });
  }
}
