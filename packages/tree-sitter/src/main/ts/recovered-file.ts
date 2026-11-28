import type { Tree } from 'web-tree-sitter';
import type { Grammar } from './language.js';
import { damagedSyntax, recoveredScopes } from './recovery.js';
import type { SourceLines } from './source-lines.js';
import { Structure } from './structure.js';
import { firstSyntaxIssue } from './syntax-issue.js';
import { scanClones } from './tokens.js';

/** Whole-file line facts plus measurable declarations from a syntax-error tree. */
export function extractRecovered(path: string, tree: Tree, source: SourceLines, grammar: Grammar) {
  const root = tree.rootNode;
  const damaged = damagedSyntax(root);
  const { scopes, omitted } = recoveredScopes(root, grammar, damaged);
  const facts = scanClones(path, tree, source, grammar, scopes.length ? damaged : false);
  const measured = scopes.length ? new Structure(grammar, source, facts.codeLines).measureRecovered(scopes) : undefined;
  const structure = measured && (measured.functions || measured.classes)
    ? { path, ...measured, ...facts }
    : { path, lines: source.count, codeLines: facts.codeLines, commentLines: facts.commentLines };
  const { reason, offset } = firstSyntaxIssue(root, grammar);
  return { structure, omitted, reason, location: source.location(offset, grammar.columns) };
}
