import { resolve } from 'node:path';
import type { FindingInput } from '../api/import/finding-import.js';

const scanners = {
  sarif: { format: 'sarif', category: 'lint' },
  'sarif-security': { format: 'sarif', category: 'security' },
  'sarif-secrets': { format: 'sarif', category: 'secret' },
  eslint: { format: 'eslint', category: 'lint' },
  osv: { format: 'osv', category: 'dependency' },
} as const;

export const importerIds = ['lcov', ...Object.keys(scanners)];

export function readInputs(root: string, inputs: readonly string[]) {
  const lcov: string[] = [];
  const findings: FindingInput[] = [];
  for (const value of inputs) {
    const equal = value.indexOf('=');
    const format = value.slice(0, equal);
    const file = value.slice(equal + 1);
    if (equal < 1 || !/^[a-z][a-z0-9-]*$/.test(format) || file === '') throw new Error('Use --import FORMAT=PATH');
    if (format === 'lcov') lcov.push(resolve(root, file));
    else {
      if (!Object.hasOwn(scanners, format)) throw new Error(`Unknown import format: ${format}. Choose ${importerIds.join(', ')}.`);
      findings.push({ ...scanners[format as keyof typeof scanners], file: resolve(root, file) });
    }
  }
  return { lcov: lcov.length ? lcov : undefined, findings };
}
