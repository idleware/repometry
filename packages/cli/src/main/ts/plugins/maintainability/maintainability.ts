import { pluginApi } from '@repometry/core/internal/engine/plugin.js';
import type { Plugin } from '@repometry/core/internal/engine/plugin.js';
import { codeStructure, structureCodeLines } from '@repometry/core/internal/model/code-structure.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { FindingResult } from '@repometry/core/internal/model/finding.js';
import type { Measurement } from '@repometry/core/internal/model/measurement.js';
import { definitions } from '@repometry/core/internal/model/measurement.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import { structuralRules } from '@repometry/core/internal/profile/maintainability.js';
import { structuralSmells } from './structural-smells.js';

export const maintainability: Plugin = {
  id: 'maintainability', version: '1.0.0', api: pluginApi,
  kinds: ['analysis'],
  produces: [{ contract: findingResult.id, persistence: 'report', metrics: [
    { id: definitions.cognitiveComplexity, label: 'Cognitive complexity', unit: 'count', scope: 'file', aggregate: 'sum',
      better: 'lower', group: 'Maintainability' },
    { id: definitions.classes, label: 'Classes', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Size' },
    { id: definitions.codeLines, label: 'Lines of code', short: 'Code lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none',
      group: 'Size' },
    { id: definitions.comments, label: 'Comment lines', unit: 'count', scope: 'file', aggregate: 'sum', better: 'none', group: 'Size' },
  ] }],
  rules: Object.entries(structuralRules).map(([id, { limit, minutesPerExcess }]) =>
    ({ id, category: 'structure', defaults: { limit, cost: minutesPerExcess } })),
  operations: [{
    id: 'file', role: 'inspection', inputs: { syntax: codeStructure, source: sourceFile }, output: findingResult,
    execute(inputs): FindingResult {
      const facts = inputs.read('syntax', codeStructure);
      const { path, observations = [], cognitiveFunctions = [], cognitiveComplexity, classes, commentLines } = facts;
      const codeLines = structureCodeLines(facts);
      const counts = [[definitions.cognitiveComplexity, cognitiveComplexity], [definitions.classes, classes],
        [definitions.codeLines, codeLines?.length], [definitions.comments, commentLines]] as const;
      return {
        findings: structuralSmells(path, observations),
        measurements: [
          ...cognitiveFunctions.map(({ line, column, name, value }) =>
            ({ definition: definitions.cognitiveComplexity, target: 'function' as const, path, line, column, name, value })),
          ...counts.flatMap<Measurement>(([definition, value]) => value === undefined ? [] : [{ definition, target: 'file', path, value }]),
        ],
      };
    },
  }],
};
