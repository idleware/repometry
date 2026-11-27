import { pluginApi } from '../../core/engine/plugin.js';
import type { Plugin } from '../../core/engine/plugin.js';
import { codeStructure } from '../../core/model/code-structure.js';
import { definitions, measurements } from '../../core/model/measurement.js';
import type { Measurement } from '../../core/model/measurement.js';

export const structure: Plugin = {
  id: 'structure',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['analysis'],
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
