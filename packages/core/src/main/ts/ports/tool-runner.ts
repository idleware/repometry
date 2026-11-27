import type { SourceFile } from '../model/source.js';

export interface ToolInvocation {
  readonly argv: readonly string[];
  readonly files: readonly SourceFile[];
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ToolResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ToolRunner {
  readonly network: 'none';
  readonly implementation?: string;
  run(invocation: ToolInvocation): Promise<ToolResult>;
}
