import type { StructuralCheck } from '../model/code-structure.js';

export const structuralRules = {
  'function-parameters': { limit: 5, minutesPerExcess: 10 },
  'return-statements': { limit: 6, minutesPerExcess: 10 },
  'boolean-logic': { limit: 4, minutesPerExcess: 10 },
  'nested-control-flow': { limit: 4, minutesPerExcess: 20 },
  'function-complexity': { limit: 15, minutesPerExcess: 10 },
  'file-complexity': { limit: 50, minutesPerExcess: 5 },
} as const satisfies Record<StructuralCheck, { readonly limit: number; readonly minutesPerExcess: number }>;

export const duplicationSettings = { minCodeLines: 12, minNodes: 50, minutesPerRepeatedLine: 2 } as const;
