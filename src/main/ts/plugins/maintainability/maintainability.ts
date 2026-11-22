import { isRecord, pluginApi } from '../../core/engine/plugin.js';
import type { DataContract, Plugin } from '../../core/engine/plugin.js';
import { isCloneSource } from '../../core/model/clone-source.js';
import type { CloneSource } from '../../core/model/clone-source.js';
import { codeStructure } from '../../core/model/code-structure.js';
import { findingResult } from '../../core/model/finding.js';
import type { FindingResult } from '../../core/model/finding.js';
import { definitions } from '../../core/model/measurement.js';
import { sourceFile } from '../../core/model/snapshot.js';
import { structuralRules } from '../../core/profile/maintainability.js';
import { structuralSmells } from './structural-smells.js';

interface FileQuality extends FindingResult {
  readonly cloneSource: CloneSource;
}

export const fileQuality: DataContract<FileQuality> = {
  id: 'repometry.maintainability-file/v1',
  accepts: (value): value is FileQuality => isRecord(value) && isCloneSource(value.cloneSource) && findingResult.accepts(value),
};

export const maintainability: Plugin = {
  id: 'maintainability', version: '1.0.0', api: pluginApi,
  kinds: ['analysis'],
  produces: [{ contract: fileQuality.id, persistence: 'report', metrics: [
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
    id: 'file', role: 'inspection', inputs: { syntax: codeStructure, source: sourceFile }, output: fileQuality,
    execute(inputs): FileQuality {
      const { path, observations, cognitiveFunctions, cognitiveComplexity, classes, commentLines, clones } = inputs.read('syntax', codeStructure);
      return {
        findings: structuralSmells(path, observations),
        measurements: [
          ...cognitiveFunctions.map(({ line, column, name, value }) =>
            ({ definition: definitions.cognitiveComplexity, target: 'function' as const, path, line, column, name, value })),
          { definition: definitions.cognitiveComplexity, target: 'file', path, value: cognitiveComplexity },
          { definition: definitions.classes, target: 'file', path, value: classes },
          { definition: definitions.codeLines, target: 'file', path, value: clones.codeLines.length },
          { definition: definitions.comments, target: 'file', path, value: commentLines },
        ],
        cloneSource: clones,
      };
    },
  }],
};
