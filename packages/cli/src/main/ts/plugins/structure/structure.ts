import { codeStructure } from '@repometry/core/internal/engine/author-contracts.js';
import { pluginManifestSchema } from '@repometry/core/internal/engine/plugin-manifest.js';
import type { BundledManifest } from '@repometry/core/internal/engine/plugin-manifest.js';
import { definitions, measurements } from '@repometry/core/internal/model/measurement.js';
import type { Measurement } from '@repometry/core/internal/model/measurement.js';

export const structure: BundledManifest = {
  schema: pluginManifestSchema,
  id: 'structure',
  category: 'maintainability',
  version: '1.0.0',
  create() {
    return {
      produces: [{ contract: measurements.id, persistence: 'report', metrics: [
        { id: definitions.lines, label: 'Physical lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Size' },
        { id: definitions.functions, label: 'Functions', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Size' },
        { id: definitions.complexity, label: 'Most complex function', short: 'Peak cyclomatic', unit: 'count', scope: 'file',
          aggregate: 'max', better: 'lower', bands: [5, 10, 20, 50], group: 'Maintainability' },
      ] }],
      operations: [{
        id: 'size',
        role: 'inspection',
        inputs: { syntax: codeStructure },
        output: measurements,
        execute(inputs): Measurement[] {
          const { path, lines, functions } = inputs.read('syntax', codeStructure);
          return [
            { definition: definitions.lines, target: 'file', path, value: lines },
            ...(functions === undefined ? [] : [{ definition: definitions.functions, target: 'file' as const, path, value: functions }]),
          ];
        },
      }, {
        id: 'complexity',
        role: 'inspection',
        inputs: { syntax: codeStructure },
        output: measurements,
        execute(inputs): Measurement[] {
          const { path, cyclomaticFunctions = [] } = inputs.read('syntax', codeStructure);
          return cyclomaticFunctions.map(({ line, column, name, value }) =>
            ({ definition: definitions.complexity, target: 'function', path, line, column, name, value }));
        },
      }],
    };
  },
};
