export interface LineRange {
  readonly first: number;
  readonly last: number;
}

/** One file's change between two commits, with the changed lines on each side. */
export interface FileLineChange {
  /** The head path; null when the file was deleted. */
  readonly path: string | null;
  /** The base path; null when the file was added. */
  readonly previous: string | null;
  /** Head side: added and modified lines. */
  readonly added: readonly LineRange[];
  /** Base side: modified and removed lines. */
  readonly removed: readonly LineRange[];
  /** Binary or undecodable content: the file changed, but its lines are unknown. */
  readonly whole: boolean;
  /** The diff's hunks, which place unchanged base lines on the head side. Empty for added, deleted and whole files. */
  readonly hunks: readonly LineHunk[];
}

/** One diff hunk: `count` lines from `first` on each side; a count of 0 is an insertion or removal after line `first`. */
export interface LineHunk {
  readonly base: { readonly first: number; readonly count: number };
  readonly head: { readonly first: number; readonly count: number };
}

export interface LineChanges {
  readonly files: readonly FileLineChange[];
}

export interface GitChanges {
  readonly files: ReadonlyMap<string, readonly LineRange[]>;
  readonly gaps: ReadonlyMap<string, string>;
}
