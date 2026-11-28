import type { FileMetricsReport } from '../wire/file-metrics-model.js';

import type { Component, ComponentMetrics } from '../wire/component-model.js';
export type { Component, ComponentMetrics } from '../wire/component-model.js';

export function componentFiles(components: readonly Component[], metrics: FileMetricsReport): readonly ComponentMetrics[] {
  return components.map(component => {
    const matchers = component.pathGlobs.map(matcher);
    return { component, paths: metrics.files.filter(({ path }) => matchers.some(match => match(path))).map(({ path }) => path) };
  });
}

function matcher(pattern: string): (path: string) => boolean {
  const parts = pattern.split(/\*+/);
  if (parts.length === 1) return path => path === pattern;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const middle = parts.slice(1, -1);
  return path => {
    if (!path.startsWith(first) || !path.endsWith(last)) return false;
    const limit = path.length - last.length;
    let position = first.length;
    if (position > limit) return false;
    for (const part of middle) {
      const found = path.indexOf(part, position);
      if (found < 0 || found + part.length > limit) return false;
      position = found + part.length;
    }
    return true;
  };
}
