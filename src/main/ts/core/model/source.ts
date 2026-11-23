export type Subject =
  | { readonly kind: 'commit'; readonly id: string }
  | { readonly kind: 'working-tree'; readonly id: string };

export interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export const maxClaimedFileBytes = 1024 * 1024;

export function isClaimedText(bytes: Uint8Array): boolean {
  return bytes.byteLength <= maxClaimedFileBytes && !bytes.subarray(0, 8192).includes(0);
}

export interface InventoryFile {
  readonly path: string;
  readonly lines: number | null;
  /** Size in bytes, from Git or the file system; independent of formatting, unlike lines. */
  readonly bytes?: number;
}

export interface SourceSnapshot {
  readonly subject: Subject;
  readonly files: readonly SourceFile[];
  readonly inventory?: readonly InventoryFile[];
  readonly generatedExcluded?: readonly string[];
  readonly oversizedClaims?: readonly string[];
}
