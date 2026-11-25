"""Repository-scoped Python structure provider for Repometry."""

import ast
from bisect import bisect_left, bisect_right
import hashlib
import io
from itertools import accumulate, groupby
import json
import sys
import tokenize
import warnings


DECISION_NODES = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp)
MATCH_CASE = getattr(ast, "match_case", ())
MATCH = getattr(ast, "Match", ())
CALLABLES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
LOOPS = (ast.For, ast.AsyncFor, ast.While)
TRY_NODES = (ast.Try, getattr(ast, "TryStar", ast.Try))
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def irrefutable(pattern):
    if isinstance(pattern, ast.MatchAs):
        return pattern.pattern is None or irrefutable(pattern.pattern)
    return isinstance(pattern, ast.MatchOr) and any(irrefutable(choice) for choice in pattern.patterns)


def decisions(node):
    if isinstance(node, DECISION_NODES):
        return 1
    if isinstance(node, ast.BoolOp):
        return len(node.values) - 1
    if isinstance(node, MATCH_CASE):
        return int(not irrefutable(node.pattern)) + int(node.guard is not None)
    return 0


def boolean_operators(node):
    if isinstance(node, ast.BoolOp):
        for index, value in enumerate(node.values):
            if index > 0:
                yield type(node.op)
            yield from boolean_operators(value)


class Scope:
    def __init__(self):
        self.cyclomatic = 1
        self.cognitive = 0
        self.returns = 0
        self.depth = 0
        self.deepest = None

    def block(self, node, depth, flat=False):
        self.cognitive += 1 if flat else 1 + depth
        if depth + 1 > self.depth:
            self.depth = depth + 1
            self.deepest = node


class Structure:
    def __init__(self, lines):
        self.lines = lines
        self.cyclomatic_functions = []
        self.cognitive_functions = []
        self.observations = []
        self.cognitive = 0
        self.classes = 0
        self.names = []
        self.anchors = []

    def analyze(self, tree):
        module = Scope()
        self.visit(tree, module)
        self.finish_scope(module, "Module")
        self.observe("file-complexity", self.cognitive, "File cognitive complexity")
        for rows in (self.cyclomatic_functions, self.cognitive_functions):
            rows.sort(key=lambda item: (item["line"], item["column"]))

    def visit(self, node, scope, depth=0, parent=None, chained=False):
        if isinstance(node, CALLABLES):
            self.visit_function(node, scope, depth)
            return
        if isinstance(node, ast.ClassDef):
            self.visit_class(node, scope, depth)
            return
        scope.cyclomatic += decisions(node)
        if isinstance(node, ast.Return):
            scope.returns += 1
        if isinstance(node, ast.BoolOp) and not isinstance(parent, ast.BoolOp):
            operators = list(boolean_operators(node))
            scope.cognitive += sum(1 for _ in groupby(operators))
            self.observe("boolean-logic", len(operators), "Logical operators in one expression", node)

        if isinstance(node, ast.If):
            self.visit_if(node, scope, depth, chained)
        elif isinstance(node, COMPREHENSIONS):
            self.visit_comprehension(node, scope, depth)
        elif isinstance(node, MATCH_CASE):
            self.visit(node.pattern, scope, depth)
            if node.guard is not None:
                scope.block(node.guard, depth)
                depth += 1
                self.visit(node.guard, scope, depth)
            self.visit_all(node.body, scope, depth)
        elif isinstance(node, TRY_NODES):
            self.visit_all(node.body, scope, depth)
            self.visit_all(node.handlers, scope, depth)
            self.visit_else(node.orelse, scope, depth)
            self.visit_all(node.finalbody, scope, depth)
        else:
            if isinstance(node, (*LOOPS, ast.ExceptHandler, ast.IfExp)) or isinstance(node, MATCH):
                scope.block(node, depth)
                depth += 1
            if isinstance(node, LOOPS) and node.orelse:
                scope.cognitive += 1
            for child in ast.iter_child_nodes(node):
                self.visit(child, scope, depth, node)

    def visit_if(self, node, scope, depth, chained):
        scope.block(node, depth, flat=chained)
        self.visit(node.test, scope, depth + 1)
        self.visit_all(node.body, scope, depth + 1)
        alternate = node.orelse
        if (len(alternate) == 1 and isinstance(alternate[0], ast.If)
                and alternate[0].col_offset == node.col_offset):
            self.visit(alternate[0], scope, depth, chained=True)
        else:
            self.visit_else(alternate, scope, depth)

    def visit_else(self, body, scope, depth):
        if body:
            scope.cognitive += 1
            self.visit_all(body, scope, depth + 1)

    def visit_comprehension(self, node, scope, depth):
        for generator in node.generators:
            scope.cyclomatic += 1 + len(generator.ifs)
            scope.block(node, depth)
            depth += 1
            self.visit(generator.target, scope, depth)
            self.visit(generator.iter, scope, depth)
            for condition in generator.ifs:
                scope.block(condition, depth)
                depth += 1
                self.visit(condition, scope, depth)
        values = (node.key, node.value) if isinstance(node, ast.DictComp) else (node.elt,)
        self.visit_all(values, scope, depth)

    def visit_header(self, node, scope, depth):
        for field, value in ast.iter_fields(node):
            if field == "body":
                continue
            if isinstance(value, ast.AST):
                self.visit(value, scope, depth)
            elif isinstance(value, list):
                self.visit_all(value, scope, depth)

    def visit_function(self, node, enclosing, depth):
        self.visit_header(node, enclosing, depth)
        name = getattr(node, "name", None)
        location = {"line": node.lineno, "column": codepoint_column(self.lines, node.lineno, node.col_offset) + 1}
        if name is not None:
            self.names.append(name)
            location["name"] = ".".join(self.names)
        label = location.get("name", "(anonymous)")
        anchor = location.get("name") or ".".join(self.anchors[-1:] + ["(anonymous)"])
        scope = Scope()
        body = [node.body] if isinstance(node, ast.Lambda) else node.body
        self.anchors.append(anchor)
        self.visit_all(body, scope, 0)
        if name is not None:
            self.names.pop()
        self.cyclomatic_functions.append({**location, "value": scope.cyclomatic})
        self.cognitive_functions.append({**location, "value": scope.cognitive})
        args = node.args
        parameters = (len(args.posonlyargs) + len(args.args) + len(args.kwonlyargs)
                      + int(args.vararg is not None) + int(args.kwarg is not None))
        # The function's own observations carry its anchor, which is still on top of the stack.
        self.observe("function-parameters", parameters, f"{label} · Parameters", node)
        self.observe("return-statements", scope.returns, f"{label} · Return statements", node)
        self.observe("function-complexity", scope.cognitive, f"{label} · Cognitive complexity", node)
        self.finish_scope(scope, label)
        self.anchors.pop()

    def visit_class(self, node, enclosing, depth):
        self.classes += 1
        self.visit_header(node, enclosing, depth)
        self.names.append(node.name)
        anchor = ".".join(self.names)
        scope = Scope()
        self.anchors.append(anchor)
        self.visit_all(node.body, scope, 0)
        self.finish_scope(scope, anchor)
        self.anchors.pop()
        self.names.pop()

    def visit_all(self, nodes, scope, depth):
        for node in nodes:
            self.visit(node, scope, depth)

    def finish_scope(self, scope, label):
        self.cognitive += scope.cognitive
        if scope.deepest is not None:
            self.observe("nested-control-flow", scope.depth, f"{label} · Control-flow depth", scope.deepest)

    def observe(self, rule, value, label, node=None):
        """Records an observation; inside a function or class it carries that scope's anchor."""
        observation = {"rule": rule, "value": value, "label": label}
        if node is not None:
            observation.update(line=node.lineno, endLine=node.end_lineno)
            if self.anchors:
                observation["anchor"] = self.anchors[-1]
        self.observations.append(observation)


def codepoint_column(lines, line, byte_offset):
    # AST offsets are UTF-8 bytes, even for files with a different source encoding.
    return len(lines[line - 1].encode("utf-8")[:byte_offset].decode("utf-8"))


def clone_candidates(path, tree, lines, starts, code_lines, min_lines, min_nodes):
    candidates = []

    def walk(value, normalize_literal=False):
        if isinstance(value, ast.AST):
            exact = [type(value).__name__]
            similar = exact.copy()
            nodes = 1
            for field, child in ast.iter_fields(value):
                child_exact, child_similar, count = walk(child, isinstance(value, ast.Constant) and field == "value")
                exact.append((field, child_exact))
                similar.append((field, child_similar))
                nodes += count
            exact, similar = fingerprint(exact), fingerprint(similar)
            if nodes >= min_nodes and isinstance(value, (ast.stmt, ast.Lambda, ast.ExceptHandler)):
                consider(value, exact, similar, nodes)
            return exact, similar, nodes
        if isinstance(value, list):
            parts = [walk(item) for item in value]
            return [item[0] for item in parts], [item[1] for item in parts], sum(item[2] for item in parts)
        # Preserve literal kinds and syntactic flags while normalizing names and literal values.
        kind = type(value).__name__
        exact = (kind, hex(value) if type(value) is int else repr(value))
        similar = (kind,) if normalize_literal or isinstance(value, str) else exact
        return exact, similar, 0

    def consider(node, exact, similar, nodes):
        line, end_line = node.lineno, node.end_lineno
        code_count = bisect_right(code_lines, end_line) - bisect_left(code_lines, line)
        if code_count >= min_lines:
            start = starts[line - 1] + codepoint_column(lines, line, node.col_offset)
            end = starts[end_line - 1] + codepoint_column(lines, end_line, node.end_col_offset)
            candidates.append({"start": start, "end": end, "line": line, "endLine": end_line,
                               "codeLines": code_count, "nodes": nodes, "exact": exact, "similar": similar})

    if len(code_lines) >= min_lines:
        walk(tree)
    return {"path": path, "scheme": "python-ast/v1", "codeLines": code_lines, "candidates": candidates}


def fingerprint(parts):
    encoded = json.dumps(parts, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def analyze(path, min_lines, min_nodes):
    with open(path, "rb") as file:
        raw = file.read()
    normalized = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    physical_lines = normalized.count(b"\n") + int(bool(normalized) and not normalized.endswith(b"\n"))
    encoding, _ = tokenize.detect_encoding(io.BytesIO(normalized).readline)
    decoded = raw.decode(encoding)
    source = decoded.replace("\r\n", "\n").replace("\r", "\n")
    lines = source.split("\n")[:physical_lines]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        tree = ast.parse(source)

    comment_lines = {
        item.start[0]
        for item in tokenize.generate_tokens(io.StringIO(source).readline)
        if item.type == tokenize.COMMENT and not item.line[:item.start[1]].strip()
    }
    code_lines = [number for number, line in enumerate(lines, 1) if line.strip() and number not in comment_lines]
    structure = Structure(lines)
    structure.analyze(tree)
    starts = list(accumulate(map(len, io.StringIO(decoded, newline="")), initial=0))
    return {
        "path": path,
        "lines": physical_lines,
        "functions": len(structure.cyclomatic_functions),
        "cyclomaticFunctions": structure.cyclomatic_functions,
        "cognitiveFunctions": structure.cognitive_functions,
        "cognitiveComplexity": structure.cognitive,
        "classes": structure.classes,
        "commentLines": len(comment_lines),
        "codeLines": code_lines,
        "observations": structure.observations,
        "clones": clone_candidates(path, tree, lines, starts, code_lines, min_lines, min_nodes),
    }


def main():
    request = json.load(sys.stdin.buffer)
    files = request["inputs"]["files"]["files"]
    duplication = request.get("settings", {}).get("duplication", {})
    min_lines, min_nodes = duplication.get("minCodeLines", 12), duplication.get("minNodes", 50)
    structures = []
    for file in files:
        path = file["path"]
        try:
            structures.append(analyze(path, min_lines, min_nodes))
        except (OSError, SyntaxError, ValueError, LookupError, RecursionError, tokenize.TokenError):
            print(json.dumps({
                "kind": "diagnostic", "severity": "warning", "message": f"Could not analyze Python file {path!r}."
            }))
    print(json.dumps({"kind": "product", "contract": "repometry.code-structures/v1", "value": structures}))


if __name__ == "__main__":
    main()
