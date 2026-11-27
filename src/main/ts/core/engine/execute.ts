import { operationCacheKey, readCachedOperation, writeCachedOperation } from './operation-cache.js';
import type { OperationCacheOptions } from './operation-cache.js';
import type { DataContract, InspectionInputs, Product } from './plugin.js';
import type { PlannedOperation } from './plan.js';

export type Outcome =
  | { readonly state: 'completed'; readonly product: Product; readonly diagnostics?: readonly { message: string; path?: string }[] }
  | { readonly state: 'failed' | 'blocked'; readonly reason: string };

export async function execute(plan: readonly PlannedOperation[], external: ReadonlyMap<string, Product>,
  cache?: OperationCacheOptions): Promise<ReadonlyMap<string, Outcome>> {
  const results = new Map<string, Outcome>();
  for (const task of plan) {
    const inputs = new Map<string, Product>();
    const missing: string[] = [];
    for (const [name, binding] of task.inputs) {
      const producer = 'operation' in binding ? results.get(binding.operation) : undefined;
      const product = 'external' in binding ? external.get(binding.external)
        : producer?.state === 'completed' ? producer.product : undefined;
      if (product) inputs.set(name, product);
      else missing.push(name);
    }

    results.set(task.key, missing.length
      ? { state: 'blocked', reason: `Unavailable inputs: ${missing.join(', ')}` }
      : await runTask(task, inputs, cache));
  }
  return results;
}

async function runTask(task: PlannedOperation, inputs: ReadonlyMap<string, Product>, cache?: OperationCacheOptions): Promise<Outcome> {
  try {
    const { operation, validateOutput } = task;
    for (const [name, contract] of Object.entries(operation.inputs)) readInput(inputs, name, contract);
    const key = cache && operationCacheKey(task, inputs, cache.configurationDigest);
    const hit = key && cache ? await readCachedOperation(cache.store, key, task) : undefined;
    if (hit) return { state: 'completed', product: hit };
    const diagnostics: { message: string; path?: string }[] = [];
    const context: InspectionInputs = {
      read: (port, contract) => {
        if (!Object.hasOwn(operation.inputs, port) || operation.inputs[port]?.id !== contract.id) {
          throw new Error(`Undeclared input contract: ${port} (${contract.id})`);
        }
        return readInput(inputs, port, contract);
      },
      emitDiagnostic: (message, path) => diagnostics.push(path === undefined ? { message } : { message, path }),
    };
    const value = await operation.execute(context);
    const { output } = operation;
    if (!output.accepts(value)) throw new Error(`Invalid output for ${output.id}`);
    if (validateOutput && !validateOutput(value)) throw new Error(`Output violates the schema for ${output.id}`);
    const product = { contract: output.id, value };
    if (key && cache && diagnostics.length === 0) await writeCachedOperation(cache.store, key, product);
    return { state: 'completed', product, ...(diagnostics.length ? { diagnostics } : {}) };
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

function readInput<T>(inputs: ReadonlyMap<string, Product>, port: string, contract: DataContract<T>): T {
  const product = inputs.get(port);
  if (!product || product.contract !== contract.id || !contract.accepts(product.value)) {
    throw new Error(`Invalid input: ${port} (${contract.id})`);
  }
  return product.value;
}
