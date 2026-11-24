# Go and Python analysis

Repometry includes Go and Python parsers that use the local `go` and `python3` executables. Go requires 1.18 or newer. Python uses the grammar of the installed interpreter. Run `repometry plugins` to see the detected versions and any missing tools.

A missing tool leaves its files in the report as unanalysed. Repometry completes the inspection with the available tools. The report records the language's availability and tool version in the applied profile, so a later change in availability or version is visible in Trends.

## Measurements

Both parsers count physical code and comment lines and measure cyclomatic and cognitive complexity for each function and method. Nested functions get separate scores. Go includes function literals. Python includes async functions, lambdas and classes. Anonymous functions are displayed as `(anonymous)`. Named methods and nested functions keep their [qualified names](metrics.md).

- Go counts one plus each `if`, loop, non-default switch or select clause, `&&`, and `||`. Locations use 1-based physical lines and byte columns.
- Python counts one plus decisions in conditions, loops, exception handlers, conditional expressions, boolean operands after the first, comprehensions, and refutable pattern cases and guards. Locations use 1-based lines and Unicode code-point columns.

## Maintainability

Both parsers measure the inputs for the shared debt model. They report parameter and return counts, nesting depth, boolean operator counts, and cognitive complexity for functions and files. Cognitive complexity starts at zero. Control-flow decisions add one plus their nesting depth. An `else if` or `elif` adds one at the original depth, and a separate `else` adds one. A run of the same boolean operator adds one. File scores include functions, methods and flow outside them.

- Go treats switch, type switch and select as nested decisions. Their individual clauses do not add cognitive points. Labeled jumps add one. Method parameter counts exclude the receiver.
- Python treats match dispatch and guards and each comprehension loop or filter as decisions. Exception handlers add a decision. The try and finally suites and with blocks do not add depth. Parameter counts include `self`, `cls` and each declared variadic parameter.

Duplication uses subtrees from each language's AST. Exact fingerprints retain names and literals. Similar fingerprints normalize them while retaining operators and structure. Go and Python fingerprints are compared within their own language. Go leaves the class count unmeasured.

The packaged parsers read a temporary copy of the selected source files. The Go runner uses local standard-library tooling with module downloads disabled. The Python runner uses the standard library in isolated mode. [Configured process plugins](process-plugins.md) use Docker.

## Importing coverage

```sh
go test -coverprofile=coverage.out ./...
npx repometry analyze --import go-cover=coverage.out

coverage run -m pytest
coverage lcov -o coverage.lcov
npx repometry analyze --import lcov=coverage.lcov
```

The Go importer accepts `set`, `count` and `atomic` profiles. It maps module-qualified paths using the modules in the inspected revision. Each nonempty block contributes hits to its source lines. When blocks overlap a line, the importer takes the greatest hit count in that profile. Repeat `--import` to combine profiles. Go's format reports block counts. Python LCOV can contribute line, branch and function measurements when the generating tool provides them.
