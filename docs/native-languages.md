# Go and Python analysis

Repometry parses Go and Python with the built-in `tree-sitter` plugin. It runs the tree-sitter grammars as WebAssembly modules inside Node.js. The package ships both grammars: tree-sitter-go 0.25.0 and tree-sitter-python 0.25.0, MIT licensed. Nothing to install. Analysis needs no `go` or `python3`, no compiler, no download and no cache.

The plugin ID is `tree-sitter`, its operation is `tree-sitter/parse`, and it provides the languages `go` and `python`. A grammar loads when the first file of its language is parsed. Repometry does not load a grammar for a language the repository does not contain.

A [Docker language plugin](process-plugins.md) or a [JavaScript language plugin](plugins.md#languages) that provides `go` or `python` does not replace the built-in parser by itself. Both providers compete for the language, so the config needs a `parsers` line that chooses between them, or lists them in order of preference. [Parsers](cli.md#parsers) gives the rule. [Write a plugin](plugins.md#languages) lists the fields of a language.

## Measurements

Both languages report physical code and comment lines and cyclomatic and cognitive complexity for each function and method. Nested functions get separate scores. Go includes function literals. Python includes async functions and lambdas. Class bodies count toward the file score only. Anonymous functions are displayed as `(anonymous)`. Named methods and nested functions keep their [qualified names](metrics.md).

| | Go | Python |
| --- | --- | --- |
| Label and colour | Go, `#00add8` | Python, `#3572a5` |
| Files | `.go` | `.py` |
| Measures | functions, cyclomatic and cognitive complexity, comment and code lines, structural checks, duplication | the same, and classes |
| Columns | 1-based lines, byte columns | 1-based lines, Unicode code-point columns |
| Source encoding | UTF-8 | The encoding declaration of PEP 263, or UTF-8 |

- Go counts one plus each `if`, loop, non-default switch or select clause, `&&`, and `||`.
- Python counts one plus decisions in conditions, loops, exception handlers, conditional expressions, boolean operands after the first, comprehensions, and refutable pattern cases and guards.

Go leaves the class count unmeasured.

## Maintainability

Both languages measure the inputs for the shared debt model. They report parameter and return counts, nesting depth, boolean operator counts, and cognitive complexity for functions and files. Cognitive complexity starts at zero. Control-flow decisions add one plus their nesting depth. An `else if` or `elif` adds one at the original depth, and a separate `else` adds one. A run of the same boolean operator adds one. File scores include functions, methods and flow outside them.

- Go treats switch, type switch and select as nested decisions. Their individual clauses do not add cognitive points. Labeled jumps add one. Method parameter counts exclude the receiver.
- Python treats match dispatch and guards and each comprehension loop or filter as decisions. Exception handlers add a decision. The try and finally suites and with blocks do not add depth. Parameter counts include `self`, `cls` and each declared variadic parameter.

## Duplication

Duplication for Go and Python counts tokens. The detector compares only files of the same language. [Technical debt](metrics.md#technical-debt) gives the matching and cost rules.

A candidate is a declaration, statement or block with at least 50 significant tokens that spans at least 12 code lines. Each candidate gets two fingerprints:

- The exact fingerprint hashes the token spellings.
- The similar-code fingerprint hashes the same sequence with each identifier and literal replaced by its kind.

Comments, whitespace and layout do not change a fingerprint. A file with fewer than 12 code lines has no candidates. Import declarations are never candidates. A definition and the block inside it can both be candidates. Candidates with the same token range count once.

The facts record the scheme `go-tokens/v1` or `python-tokens/v1`.

### Token sequence

A token sequence is a list of token entries. These rules apply to both languages:

- A token is a lexical token of the language, as its own lexer reports it, minus the tokens that each language section omits.
- A token belongs to a candidate when it starts inside the candidate's source range. The candidate's tokens are consecutive in the file's sequence.
- An entry in the exact sequence is the length of the token's spelling in UTF-16 code units, a colon, and the spelling. For example, `main` gives `4:main`.
- An entry in the similar sequence is the same as the exact entry, except that a token with a kind gives `!kind:`. For example, `main` gives `!identifier:`. A token without a kind keeps its exact entry.
- A fingerprint is the SHA-256 digest of the concatenated entries of the candidate's tokens, in base64url.
- The line count of a candidate is the number of code lines between its first and last token, inclusive. Lines with only comments or blanks are not code lines.

### Go tokens

The sequence follows the tokens of `go/scanner`.

- Omit comments, whitespace and the semicolons that the scanner inserts at a newline. Keep explicit semicolons, keywords, operators and punctuation.
- Spell a raw string literal without its carriage returns.
- Kinds: `identifier` for identifiers, including predeclared names, `true`, `false`, `nil` and `iota`; `string` for raw and interpreted strings; `rune`; `integer`; `float`; `imaginary`.
- The blank identifier `_` has no kind. Its spelling stays `_` in both sequences.

Candidates:

| Group | Syntax |
| --- | --- |
| Declarations | `const`, `var` and `type` declarations, function and method declarations, function literals |
| Statements | assignment, short variable declaration, increment, decrement, expression, send, `return`, `break`, `continue`, `goto`, `fallthrough`, labeled, `go`, `defer`, `if`, `for`, expression switch, type switch, `select` |
| Clauses | expression case, type case, communication case, `default` |
| Blocks | every `{ … }` block |

### Python tokens

The sequence follows the tokens of Python's `tokenize` module.

- Omit the encoding marker, comments, indentation and dedentation, line endings and line continuations. Keep keywords, operators and punctuation.
- Treat `match`, `case`, `type`, `__future__`, `print` and `exec` as identifiers in every context.
- A quoted string, with its prefix, is one token. When a lexer splits an f-string into parts, join the parts into one token.
- Kinds: `identifier`; `boolean` for `True` and `False`; `none` for `None`; `string`; `integer`; `float`; `imaginary` for a number that ends in `j` or `J`.
- The name `_` has no kind. Its spelling stays `_` in both sequences, also when it is a wildcard.

Candidates:

| Group | Syntax |
| --- | --- |
| Definitions | `def`, `class`, `lambda`, `type` alias statements |
| Statements | expression, `assert`, `break`, `continue`, `del`, `global`, `nonlocal`, `pass`, `raise`, `return`, `exec` and `print` statements |
| Compound | `if`, `elif`, `for`, `while`, `try`, `except`, `except*`, `with`, `match`, `case` |
| Blocks | every indented suite |

## Failure and limits

A file that the parser cannot parse gets one diagnostic from `tree-sitter/parse`. It gives the line and column of the first token the grammar rejects and, when the grammar knows it, the expected token. Lines and columns are 1-based. A Go column counts bytes, and a Python column counts characters. The operations that read the file's structure are recorded as blocked, with `Unavailable inputs: syntax`. The file stays in the inventory as not analysed, the inspection is partial, and the run goes on. For example:

```text
Expected ")" at line 2, column 8
Expected ":" or "->" at line 1, column 8
Unexpected syntax at line 3, column 9
```

A Go file must start with a package clause. Otherwise the diagnostic is `Expected a package clause at line 1, column 1`.

The parser differs from the compiler's own parser in these ways:

- Python 2 files, and Python nested deeper than CPython allows, are measured.
- A few valid but unusual files are rejected with a diagnostic.
- Duplication fingerprints depend on token-level formatting, such as a trailing comma or adjacent string literals.
- A very large file needs much memory: about 110 to 160 MB for each MiB of source. A 1 MiB file needs about 0.3 GB, and a 10 MiB file 1.1 to 1.6 GB.

## Profile

An inspection records the plugins and grammars that took part. The profile covers:

- the parser plugins that parsed at least one file;
- the grammars those plugins used, by name and version, such as `tree-sitter-go` `0.25.0`;
- the file selectors, the `include` globs, of the languages the repository contains.

Adding or updating a grammar for a language the repository does not contain does not change its profile. A change in a grammar a repository uses does. Trends then shows an "Inspection profile changed" mark, and no trend delta crosses it.

## Importing coverage

```sh
go test -coverprofile=coverage.out ./...
npx repometry analyze --import go-cover=coverage.out

coverage run -m pytest
coverage lcov -o coverage.lcov
npx repometry analyze --import lcov=coverage.lcov

coverage xml -o coverage.xml
npx repometry analyze --import cobertura=coverage.xml
```

Generating coverage uses the project's own tools: `go test -coverprofile` and coverage.py. Importing it needs no tool.

The Go importer accepts `set`, `count` and `atomic` profiles. It maps module-qualified paths using the modules in the inspected revision. Each nonempty block contributes hits to its source lines. When blocks overlap a line, the importer takes the greatest hit count in that profile. Repeat `--import` to combine profiles. Go's format reports block counts. Python LCOV can contribute line, branch and function measurements when the generating tool provides them.

The Cobertura importer reads the XML that coverage.py, c8, Istanbul, coverlet, PHPUnit and other tools write. It maps each class `filename` to a repository file. An absolute filename is the only candidate. A relative one is tried under each `<source>` in the file and under the repository root. When exactly one candidate is a file of the inspected revision, the importer uses it. When two or more are, the import fails with `Ambiguous Cobertura source`. When none is, the file is reported as a coverage gap, `LCOV source is outside the inspected file set`. `--import-root` does not apply. In the `imports` key of `repometry.config.json`, use the same `cobertura=PATH` form with a path relative to the repository root.

Line hits come from each class's `<lines>`. Branches come from the `condition-coverage` counts on those lines. Functions come from `<methods>`, with a method's first line as its declaration. coverage.py writes no methods, so its Cobertura file gives no function coverage; its LCOV file does.

## Upgrading from 0.12 or earlier

- Profile. New inspections record the profile `repository/v4`. The first inspection made with this version starts a new profile for every repository, so Trends shows one "Inspection profile changed" mark. Saved reports keep their profiles.
- Plugin IDs. The IDs `go-ast` and `python-ast` do not exist. A `parsers` entry that names one fails with `parsers/go/0 names unknown plugin go-ast; go is provided by tree-sitter`. Name `tree-sitter`, or remove the entry when no other plugin provides the language.
- Duplication anchors. Go and Python duplication findings have new anchors. Update every `ignore` rule that uses one.
- Cache. `repometry cache clear` also removes the compiled Go parser that earlier versions left in the system cache.
