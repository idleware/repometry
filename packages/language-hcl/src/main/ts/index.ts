import { codeStructure, measurements } from '@repometry/core';
import type { Measurement, MetricDescriptor, Operation } from '@repometry/core';
import { treeSitter } from '@repometry/tree-sitter';
import { hcl } from './hcl.js';

export { hcl };

const metric: MetricDescriptor = {
  id: 'repometry.hcl-blocks/v1', label: 'HCL blocks', unit: 'count',
  scope: 'file', aggregate: 'sum', better: 'none', group: 'Size',
  description: 'Block declarations in HCL, including nested blocks.',
};

const blocks: Operation = {
  id: 'blocks', role: 'inspection', inputs: { syntax: codeStructure }, output: measurements,
  execute(inputs): Measurement[] {
    const { path, declarations } = inputs.read('syntax', codeStructure);
    return declarations === undefined ? [] : [{ definition: metric.id, target: 'file', path, value: declarations }];
  },
};

const parser = treeSitter(hcl);
const plugin: typeof parser = {
  ...parser,
  create() {
    const { operations, produces } = parser.create();
    return {
      operations: [...operations, blocks],
      produces: [...produces, { contract: measurements.id, persistence: 'report', metrics: [metric] }],
    };
  },
};

export default plugin;
