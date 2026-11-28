import type { PluginCategory } from '@repometry/core/internal/model/inspection-category.js';
import type { DataContract, InspectionInputs, Operation } from '@repometry/core/internal/engine/plugin.js';
import { readFindings, readStructure, writeFindings, writeStructure } from '@repometry/core/internal/engine/author-contracts.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import { codeStructure, codeStructures } from '@repometry/core/internal/model/code-structure.js';

export function authorOperation(id: string, category: PluginCategory, operation: Operation): Operation {
  const { output } = operation;
  const inputs = Object.fromEntries(Object.entries(operation.inputs).map(([port, contract]) => [port, storedContract(contract)]));
  return { ...operation, inputs, output: storedContract(output), async execute(context) {
    const result = await operation.execute({ ...context, read: (port, contract) => readValue(context, port, contract) });
    return authorResult(id, category, output.id, result);
  } };
}

function authorResult(id: string, category: PluginCategory, output: string, result: unknown): unknown {
  if (output === findingResult.id) return writeFindings(result, id, category);
  if (output === codeStructure.id) return writeStructure(result);
  if (output === codeStructures.id && Array.isArray(result)) return result.map(writeStructure);
  return result;
}

const stored = new Map<string, DataContract>([codeStructure, codeStructures, findingResult].map(contract => [contract.id, contract]));

function storedContract(contract: DataContract): DataContract {
  return stored.get(contract.id) ?? contract;
}

function readValue<T>(inputs: InspectionInputs, port: string, contract: DataContract<T>): T {
  if (contract.id === codeStructure.id) return readStructure(inputs.read(port, codeStructure)) as T;
  if (contract.id === codeStructures.id) return inputs.read(port, codeStructures).map(readStructure) as T;
  if (contract.id === findingResult.id) return readFindings(inputs.read(port, findingResult)) as T;
  return inputs.read(port, contract);
}
