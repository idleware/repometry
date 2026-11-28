import { isRecord } from '@repometry/core/internal/engine/plugin.js';

import type { IgnoreView } from '../wire/inspection-context-model.js';

export function ignoreView(value: unknown): readonly IgnoreView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const facts = Object.fromEntries((['tool', 'rule', 'reason'] as const).flatMap(key =>
      typeof entry[key] === 'string' ? [[key, entry[key]]] : []));
    const paths: unknown[] = Array.isArray(entry.path) ? entry.path : [entry.path];
    return paths.map(path => typeof path === 'string' ? { ...facts, path } : facts);
  });
}
