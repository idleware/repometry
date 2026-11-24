import type { Operation } from '../core/engine/plugin.js';
import { codeStructure, codeStructures, structureCodeLines } from '../core/model/code-structure.js';
import type { CodeStructure, StructureMeasure } from '../core/model/code-structure.js';
import type { ProvidedLanguage } from '../core/model/language.js';
import { digest } from '../core/model/snapshot.js';

export function restrictStructureMeasures(operation: Operation, declared: readonly ProvidedLanguage[],
  language: (path: string) => string | undefined): Operation {
  const measured = new Map(declared.flatMap(entry => entry.measures === undefined ? [] : [[entry.id, entry.measures] as const]));
  if (!measured.size) return operation;
  const implementation = digest(JSON.stringify([operation.implementation ?? operation.execute.toString(), [...measured]]));
  return { ...operation, implementation, async execute(inputs) {
    const value = await operation.execute(inputs);
    if (operation.scope === 'repository') return codeStructures.accepts(value) ? value.map(project) : value;
    return codeStructure.accepts(value) ? project(value) : value;
  } };

  function project(facts: CodeStructure): CodeStructure {
    const id = language(facts.path);
    const measures = id === undefined ? undefined : measured.get(id);
    return measures === undefined ? facts : selectMeasures(facts, measures);
  }
}

function selectMeasures(facts: CodeStructure, measures: readonly StructureMeasure[]): CodeStructure {
  const selected = { ...facts };
  if (!measures.includes('functions')) delete selected.functions;
  if (!measures.includes('cyclomaticComplexity')) delete selected.cyclomaticFunctions;
  if (!measures.includes('cognitiveComplexity')) {
    delete selected.cognitiveComplexity;
    delete selected.cognitiveFunctions;
  }
  if (!measures.includes('classes')) delete selected.classes;
  if (!measures.includes('commentLines')) delete selected.commentLines;
  if (measures.includes('codeLines')) selected.codeLines = structureCodeLines(facts);
  else delete selected.codeLines;
  if (!measures.includes('duplication')) delete selected.clones;
  if (!measures.includes('structuralRules')) delete selected.observations;
  return selected;
}

export function unmeasuredStructure(facts: CodeStructure): readonly StructureMeasure[] {
  const values = {
    functions: facts.functions,
    cyclomaticComplexity: facts.cyclomaticFunctions,
    cognitiveComplexity: facts.cognitiveComplexity,
    classes: facts.classes,
    commentLines: facts.commentLines,
    codeLines: structureCodeLines(facts),
    duplication: facts.clones,
    structuralRules: facts.observations,
  } satisfies Record<StructureMeasure, unknown>;
  return (Object.keys(values) as StructureMeasure[]).filter(key => values[key] === undefined);
}
