import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { toolFailure } from './failure.js';

interface HostTool {
  readonly binary: string;
  readonly resolved: string;
  readonly bytes: number;
  readonly modified: number;
}

export interface VersionedHostTool extends HostTool {
  readonly version: string;
}

export function hostToolPath(): string {
  return (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);
}

export function probeHostTool(name: string, args: readonly string[], path: string):
  VersionedHostTool | { readonly unavailableReason: string } {
  const tool = findHostTool(name, path);
  if (!tool) return { unavailableReason: `${name} not found on PATH` };
  const home = createToolHome('repometry-tool-version-');
  try {
    const result = spawnSync(tool.binary, args, { cwd: home, env: toolEnvironment(path, home), encoding: 'utf8',
      timeout: 5_000, maxBuffer: 4_096, killSignal: 'SIGKILL', windowsHide: true });
    const output = result.stdout?.trim() || result.stderr?.trim();
    const version = result.status === 0 && !result.error
      ? output?.match(/\b(?:go|Python\s+)(\d+(?:\.\d+)+(?:[a-z][\w.-]*)?)/i)?.[1] : undefined;
    return version === undefined ? { unavailableReason: versionFailure(name, result) } : { ...tool, version };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function findHostTool(name: string, path: string): HostTool | undefined {
  const executable = process.platform === 'win32' ? name + '.exe' : name;
  let inaccessible: HostTool | undefined;
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const tool = inspectExecutable(join(directory, executable));
    if (!tool) continue;
    try {
      accessSync(tool.resolved, constants.X_OK);
      return tool;
    } catch {
      inaccessible ??= tool;
    }
  }
  return inaccessible;
}

function inspectExecutable(binary: string): HostTool | undefined {
  try {
    const resolved = realpathSync(binary);
    const info = statSync(resolved);
    if (info.isFile()) return { binary, resolved, bytes: info.size, modified: info.mtimeMs };
  } catch {
    // Continue searching when this path entry does not contain the tool.
  }
}

function versionFailure(name: string, result: SpawnSyncReturns<string>): string {
  const message = `${name} version check failed`;
  if (result.error) {
    const code = 'code' in result.error ? result.error.code : result.error.name;
    return `${message}: ${String(code)}`;
  }
  const output = result.stderr?.trim() || result.stdout?.trim();
  const firstLine = output?.split(/\r?\n/, 1)[0];
  if (firstLine) return toolFailure(message, Buffer.from(firstLine)).replace('\n', ': ');
  if (result.signal) return `${message}: terminated by ${result.signal}`;
  return result.status === 0 ? `${message}: no version output` : `${message}: exit status ${result.status}`;
}

/**
 * Creates a private home folder for a host tool, with go's telemetry off in it. With telemetry on, go leaves a process
 * behind that writes to the home after the command ends, which makes the home's removal fail or brings the folder back.
 * The mode file sits where go looks for its configuration on Linux and on macOS. On Windows go finds no configuration
 * folder in this environment, which turns telemetry off as well.
 */
export function createToolHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  for (const configuration of ['.config', join('Library', 'Application Support')]) {
    const telemetry = join(home, configuration, 'go', 'telemetry');
    mkdirSync(telemetry, { recursive: true });
    writeFileSync(join(telemetry, 'mode'), 'off');
  }
  return home;
}

export function toolEnvironment(PATH: string, HOME: string): NodeJS.ProcessEnv {
  return { PATH, HOME, GOCACHE: join(HOME, 'go-cache'), GOENV: 'off', GO111MODULE: 'off',
    GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0' };
}
