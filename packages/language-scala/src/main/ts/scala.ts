import { measures } from '@repometry/tree-sitter';
import type { LanguageUnit as Grammar } from '@repometry/tree-sitter';
import manifest from '../resources/grammar.json' with { type: 'json' };

type Node = Parameters<Grammar['name']>[0];

const comments = new Set(['comment', 'block_comment']);
const cases = new Set(['case_block', 'indented_cases']);
const template = new Set(['template_body', 'with_template_body']);
const templateBody = (node: Node) => node.namedChildren.filter(child => template.has(child.type));
const declaredBody = (node: Node) => node.childrenForFieldName('body');
const partialFunction = { flow: 'function', body: partialBody, requiresBody: true, parameters: () => 1 } as const;
const namedClass = { flow: 'class', body: declaredBody } as const;

function methodParameters(node: Node): number {
  // An extension group's header supplies the same value and using parameters to each of its methods.
  const extension = node.parent;
  return parameterClauses(node) + (extension?.type === 'extension_definition' ? parameterClauses(extension) : 0);
}

function parameterClauses(node: Node): number {
  return node.childrenForFieldName('parameters').reduce((count, clause) => count + (clause.type === 'parameters'
    ? clause.namedChildren.filter(child => child.type !== 'erased_modifier' && !comments.has(child.type)).length : 0), 0);
}

function lambdaParameters(node: Node): number {
  const parameter = node.childrenForFieldName('parameters').find(child => child.isNamed);
  if (parameter?.type === 'bindings') return parameter.namedChildren.filter(child => child.type === 'binding').length;
  return Number(parameter !== undefined);
}

function lambdaBody(node: Node): readonly Node[] {
  const header = new Set([...node.childrenForFieldName('parameters'), ...node.childrenForFieldName('type_parameters')]
    .map(child => child.id));
  return node.namedChildren.filter(child => !header.has(child.id) && !comments.has(child.type));
}

function partialBody(node: Node): readonly Node[] {
  // Case blocks in a match or catch are branches of that expression. Elsewhere they define a callable.
  const owner = node.parent?.type;
  return owner === 'match_expression' || owner === 'catch_clause'
    ? [] : node.namedChildren.filter(child => child.type === 'case_clause');
}

function caseDecision(node: Node): number {
  if (node.parent?.parent?.type === 'catch_clause') return 1;
  let pattern = node.childForFieldName('pattern');
  while (pattern?.type === 'capture_pattern') pattern = pattern.childForFieldName('pattern');
  const catchAll = pattern?.type === 'wildcard' || (pattern?.type === 'identifier' && /^\p{Ll}/u.test(pattern.text));
  return Number(!catchAll);
}

const tokens: Grammar['tokens'] = {
  candidates: new Set([
    'assignment_expression', 'block', 'call_expression', 'case_block', 'case_clause', 'catch_clause',
    'class_definition', 'colon_argument', 'do_while_expression', 'enum_body', 'enum_definition', 'enumerators',
    'extension_definition', 'finally_clause', 'for_expression', 'function_definition', 'given_definition',
    'if_expression', 'indented_block', 'indented_cases', 'instance_expression', 'lambda_expression', 'match_expression',
    'object_definition', 'package_object', 'return_expression', 'template_body', 'throw_expression', 'trait_definition',
    'try_expression', 'tuple_expression', 'type_definition', 'val_definition', 'var_definition', 'while_expression',
    'with_template_body',
  ]),
  kinds: new Map([
    ['identifier', 'identifier'], ['type_identifier', 'identifier'], ['integer_literal', 'integer'],
    ['floating_point_literal', 'float'], ['character_literal', 'character'], ['string', 'string'],
    ['boolean_literal', 'boolean'], ['null_literal', 'null'], ['interpolated_string', 'interpolated-string'],
  ]),
  // The AST skips raw text between substitutions; preserve the literal's entire spelling as one token.
  literalsWithComments: new Set(['interpolated_string']),
};

export const scala: Grammar = {
  language: { id: 'scala', label: 'Scala', color: '#c22d40', extensions: ['.scala'], measures: [...measures, 'classes'] },
  tool: { package: manifest.package, version: manifest.version },
  asset: new URL('../resources/tree-sitter.wasm', import.meta.url),
  prepareSource: text => text,
  columns: 'codepoints',
  name: node => node.childForFieldName('name')?.text,
  rules: {
    function_definition: { flow: 'function', parameters: methodParameters },
    lambda_expression: { flow: 'function', body: lambdaBody, parameters: lambdaParameters },
    case_block: partialFunction,
    indented_cases: partialFunction,
    class_definition: namedClass,
    trait_definition: namedClass,
    object_definition: namedClass,
    package_object: namedClass,
    enum_definition: { flow: 'class' },
    instance_expression: { flow: 'class', body: templateBody, requiresBody: true },
    given_definition: { flow: 'class', body: templateBody, requiresBody: true },
    if_expression: { flow: 'if', decision: true },
    indented_block: { chainedAlternative: true },
    while_expression: { flow: 'nest', decision: true },
    do_while_expression: { flow: 'nest', decision: true },
    for_expression: { flow: 'nest' },
    enumerator: { decision: node => Number(node.children.some(child => child.type === '<-' || child.type === '←')) },
    guard: { flow: 'nest', decision: true },
    match_expression: { flow: 'nest' },
    case_clause: { decision: caseDecision },
    catch_clause: { flow: 'nest', decision: node => Number(!node.namedChildren.some(child => cases.has(child.type))) },
    return_expression: { exit: 'return' },
  },
  parens: new Set(['parenthesized_expression']), comments, extras: new Set(),
  logicalTypes: new Set(['infix_expression']), logicalOperators: new Set(['&&', '||']),
  logicalOperatorSpelling: true, logicalCognitive: 'sequence',
  moduleDepthLabel: 'Module · Control-flow depth', tokens,
};
