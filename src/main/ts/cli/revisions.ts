export interface RevisionRange { readonly base: string; readonly head: string }

/** Reads `BASE..HEAD` or `BASE..`; returns undefined for a single revision. Git refnames cannot contain `..`. */
export function parseRange(value: string): RevisionRange | undefined {
  if (!value.includes('..')) return undefined;
  if (value.includes('...')) throw new Error(`${value}: a symmetric range has no first-parent line; use BASE..HEAD`);
  const index = value.indexOf('..');
  const base = value.slice(0, index);
  const head = value.slice(index + 2);
  if (!base) throw new Error(`${value}: a range needs a base, as in HEAD~10..HEAD`);
  if (head.includes('..')) throw new Error(`${value}: use one BASE..HEAD range`);
  return { base, head: head || 'HEAD' };
}
