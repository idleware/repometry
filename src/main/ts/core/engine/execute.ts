import type { DataContract, InspectionInputs, Product } from './plugin.js';
import type { PlannedOperation } from './plan.js';

export type Outcome =
  | { readonly state: 'completed'; readonly product: Product }
  | { readonly state: 'failed' | 'blocked'; readonly reason: string };

export async function execute(plan: readonly PlannedOperation[], external: ReadonlyMap<string, Product>): Promise<ReadonlyMap<string, Outcome>> {
  const results = new Map<string, Outcome>();
  for (const task of plan) {
    const inputs = new Map<string, Product>();
    for (const [name, binding] of task.inputs) {
      const producer = 'operation' in binding ? results.get(binding.operation) : undefined;
      const product = 'external' in binding ? external.get(binding.external)
        : producer?.state === 'completed' ? producer.product : undefined;
      if (product) inputs.set(name, product);
    }

    const missing = [...task.inputs.keys()].filter(name => !inputs.has(name));
    if (missing.length > 0) {
      results.set(task.key, { state: 'blocked', reason: `Unavailable inputs: ${missing.join(', ')}` });
      continue;
    }

    try {
      for (const [name, contract] of Object.entries(task.operation.inputs)) {
        readInput(inputs, name, contract);
      }
      const context: InspectionInputs = {
        read: (port, contract) => {
          if (!Object.hasOwn(task.operation.inputs, port) || task.operation.inputs[port]?.id !== contract.id) {
            throw new Error(`Undeclared input contract: ${port} (${contract.id})`);
          }
          return readInput(inputs, port, contract);
        },
      };
      const value = await task.operation.execute(context);
      const { output } = task.operation;
      if (!output.accepts(value)) throw new Error(`Invalid output for ${output.id}`);
      if (task.validateOutput && !task.validateOutput(value)) throw new Error(`Output violates the schema for ${output.id}`);
      results.set(task.key, { state: 'completed', product: { contract: output.id, value } });
    } catch (error) {
      results.set(task.key, { state: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function readInput<T>(inputs: ReadonlyMap<string, Product>, port: string, contract: DataContract<T>): T {
  const product = inputs.get(port);
  if (!product || product.contract !== contract.id || !contract.accepts(product.value)) {
    throw new Error(`Invalid input: ${port} (${contract.id})`);
  }
  return product.value;
}
