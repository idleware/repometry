import type { StructureMeasure } from '../model/code-structure.js';
import type { LanguageSyntax } from '../model/language.js';
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

/** A language parser that runs as a host process: the binary, how to start it and what it measures. */
export type HostLanguageDescriptor = Readonly<{ id: string; language: string; binary: string; args: readonly string[];
  versionArgs: readonly string[]; script: string; measures: readonly StructureMeasure[]; syntax: LanguageSyntax }>;
