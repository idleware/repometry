export interface LineRange {
  readonly first: number;
  readonly last: number;
}

export interface GitChanges {
  readonly files: ReadonlyMap<string, readonly LineRange[]>;
  readonly gaps: ReadonlyMap<string, string>;
}
