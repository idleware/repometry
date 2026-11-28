# Languages

Repometry parses Go, Python, Java, Ruby, PHP, Kotlin and HCL with tree-sitter grammars. Each grammar runs as a WebAssembly module inside Node.js. Analysis needs no compiler, interpreter, download or cache. JavaScript and TypeScript use the built-in `babel-syntax` plugin, which this page does not cover.

Each language is one plugin in its own package. The plugin ID is `language-<id>`, its operation is `language-<id>/parse`, and the package is `@repometry/language-<id>`. A grammar loads when the first file of its language is parsed.

A [Docker language plugin](process-plugins.md) or a [JavaScript language plugin](plugins.md#languages) that provides one of these languages does not replace the parser by itself. Both providers compete for the language, so the config needs a `parsers` line that chooses between them. [Parsers](cli.md#parsers) gives the rule. [Write a plugin](plugins.md#languages) lists the fields of a language.

## Supported languages

| Language | ID | Files | Plugin | Ships in |
| --- | --- | --- | --- | --- |
| Go | `go` | `.go` | `language-go` | `repometry`, `@repometry/all` |
| Python | `python` | `.py` | `language-python` | `repometry`, `@repometry/all` |
| Java | `java` | `.java` | `language-java` | `repometry`, `@repometry/all` |
| Ruby | `ruby` | `.rb` | `language-ruby` | `@repometry/all` |
| PHP | `php` | `.php` | `language-php` | `repometry`, `@repometry/all` |
| Kotlin | `kotlin` | `.kt`, `.kts` | `language-kotlin` | `@repometry/all` |
| HCL | `hcl` | `.hcl`, `.tf`, `.tfvars` | `language-hcl` | `@repometry/all` |
| Rust | | | | Not yet. The grammar rejects too many valid files. |
| C# | `csharp` | `.cs` | `language-csharp` | Separate install: `@repometry/language-csharp`. A file with code the grammar cannot read, mostly around preprocessor directives, keeps its lines and every function outside that code; the report counts such files. |
| C, C++, Swift | | | | Not yet. |

JavaScript and TypeScript ship in every package. A language in the package you run needs no setup; see [Packages](cli.md#packages). A file of a language without a plugin stays in the inventory as not analysed.

### Add a language to a smaller package

Install the package next to Repometry, then reference it in `repometry.config.json`:

```sh
npm install @repometry/language-kotlin
```

```json
{ "plugins": ["@repometry/language-kotlin"] }
```

[Plugins](cli.md#plugins) lists the reference forms. A language that the package includes needs no entry, but `"plugins": ["language-java"]` configures it by ID.

## Measurements

Every language reports physical code and comment lines and cyclomatic and cognitive complexity for each function. Nested functions get separate scores. Class bodies count toward the file score only. Anonymous functions are displayed as `(anonymous)`. Named methods and nested functions keep their [qualified names](metrics.md).

| | Go | Python | Java | Ruby | PHP | Kotlin |
| --- | --- | --- | --- | --- | --- | --- |
| Label and colour | Go, `#00add8` | Python, `#3572a5` | Java, `#b07219` | Ruby, `#701516` | PHP, `#4f5d95` | Kotlin, `#a97bff` |
| Classes | no | yes | yes | yes | yes | yes |
| Columns | bytes | code points | code points | code points | bytes | code points |
| Source encoding | UTF-8 | PEP 263 or UTF-8 | UTF-8 | UTF-8 | UTF-8 | UTF-8 |
| Syntax colours | yes | yes | yes | no | no | no |
| Duplication scheme | `go-tokens/v1` | `python-tokens/v1` | `java-tokens/v1` | `ruby-tokens/v1` | `php-tokens/v1` | `kotlin-tokens/v1` |

All languages measure functions, complexity, comment and code lines, structural checks and duplication. Lines are 1-based. A file in a language without syntax colours shows as plain text. A source file that is not valid UTF-8 is rejected with a diagnostic.

### Go and Python rules

- Go counts one plus each `if`, loop, non-default switch or select clause, `&&`, and `||`. Functions include function literals.
- Python counts one plus decisions in conditions, loops, exception handlers, conditional expressions, boolean operands after the first, comprehensions, and refutable pattern cases and guards. Functions include async functions and lambdas.

### HCL rules

HCL is declarative, so a file has no functions, classes or complexity. Repometry measures:

- lines, code lines and comment lines;
- blocks: every block declaration, nested and unlabelled ones included. Attributes and object literals are not blocks. The metric is `repometry.hcl-blocks/v1`, a file metric under Size;
- duplication, with the `hcl-tokens/v1` scheme and the common thresholds. The similar sequence keeps block kinds, keys and operators, and replaces literal spellings.

`.tf.json` and other JSON variants stay JSON. A template that is not valid HCL until it is expanded, such as a Go format string with `%q`, is rejected with a diagnostic. In test corpora the grammar rejected 0% of Terraform module files and about 1.8% of Packer files, all of them such templates. The grammar file keeps its upstream Apache-2.0 licence next to it in the package.

### Java, Ruby, PHP and Kotlin rules

Cyclomatic complexity starts at one in every language. Cognitive complexity adds one plus the nesting depth for a nested decision. A chained `else if` and a separate `else` add one each, at no depth. A run of the same boolean operator adds one. Only explicit `return` statements count as returns.

| | Java | Ruby |
| --- | --- | --- |
| Function | A method or constructor with a body, a compact record constructor, a lambda. A method signature without a body is skipped. | A `def`, a singleton method, an arrow lambda. A block and a `lambda` or `proc` call belong to the enclosing function. |
| Class | Class, interface, annotation, enum, record | Class and `class << object` body. A module qualifies names and is not counted. |
| Cyclomatic adds one for | `if`, `else if`, loops, `catch`, `?:`, non-default `case`, `&&`, `\|\|` | `if`, `unless`, `elsif`, loops, each `when`, `in` or `rescue`, a postfix modifier, `?:`, `&&`, `\|\|`, `and`, `or` |
| Cognitive nests | the same constructs except `case`; a `switch` nests | conditionals, loops, `case`, `rescue`, `?:`, modifiers. A `when` and the `else` arm of a `case` add nothing |
| Extra cognitive points | A labelled `break` or `continue` | none |
| Parameters | Each parameter. A receiver parameter does not count. | Each formal parameter, including rest, keyword, block and forwarding |

| | PHP | Kotlin |
| --- | --- | --- |
| Function | A function or method with a body, a closure, an arrow function. An abstract or interface method without a body is skipped. | A function with a body, an anonymous function, a lambda, a secondary constructor, a property accessor. A primary constructor and a function without a body are skipped. |
| Class | Class, anonymous class, interface, trait, enum | Class, interface, enum, named and companion object, object expression |
| Cyclomatic adds one for | `if`, `elseif`, loops, `catch`, `?:`, non-default `case` or `match` arm, `&&`, `\|\|`, `and`, `or`, `??`, `??=`, `?->` | `if`, `else if`, loops, non-`else` `when` entry, `catch`, `?:`, `&&`, `\|\|` |
| Cognitive nests | `if`, loops, `switch`, `match`, `catch`, `?:`. `try`, `finally`, `case` and null-aware operators add nothing | `if`, loops, `when`, `catch`. `?:` adds to cyclomatic only |
| Extra cognitive points | `goto`, a numeric `break` or `continue` level | none |
| Parameters | Each parameter. Closure `use` variables do not count. | Each value parameter. Receivers, `it` and defaults do not count. |

- A `when` entry or `match` arm with several values adds one. `elseif` and `else if` score the same in PHP.
- A Kotlin function is named `constructor`, `property.get` or `property.set` where it has no name of its own. A nameless companion object is `Companion`.
- Java, Ruby and Kotlin count a line with code and a comment as a code line. Ruby counts `=begin` blocks as comments and heredoc text as code. Kotlin counts triple-quoted string text as code.
- PHP counts markup outside `<?php` tags as code lines.

## Maintainability

Every language measures the inputs for the shared debt model. They report parameter and return counts, nesting depth, boolean operator counts, and cognitive complexity for functions and files. Cognitive complexity starts at zero. Control-flow decisions add one plus their nesting depth. An `else if` or `elif` adds one at the original depth, and a separate `else` adds one. A run of the same boolean operator adds one. File scores include functions, methods and flow outside them.

The rules below are for Go and Python. The other languages follow [their rules](#java-ruby-php-and-kotlin-rules).

- Go treats switch, type switch and select as nested decisions. Their individual clauses do not add cognitive points. Labeled jumps add one. Method parameter counts exclude the receiver.
- Python treats match dispatch and guards and each comprehension loop or filter as decisions. Exception handlers add a decision. The try and finally suites and with blocks do not add depth. Parameter counts include `self`, `cls` and each declared variadic parameter.

## Duplication

Duplication counts tokens in every language. The detector compares only files of the same language. [Technical debt](metrics.md#technical-debt) gives the matching and cost rules.

A candidate is a declaration, statement or block with at least 50 significant tokens that spans at least 12 code lines. Each candidate gets two fingerprints:

- The exact fingerprint hashes the token spellings.
- The similar-code fingerprint hashes the same sequence with each identifier and literal replaced by its kind.

Comments, whitespace and layout do not change a fingerprint. A file with fewer than 12 code lines has no candidates. Import declarations are never candidates. A definition and the block inside it can both be candidates. Candidates with the same token range count once.

The facts record the scheme `<language>-tokens/v1`, such as `go-tokens/v1`.

### Token sequence

A token sequence is a list of token entries. These rules apply to both languages:

- A token is a lexical token of the language, as its own lexer reports it, minus the tokens that each language section omits.
- A token belongs to a candidate when it starts inside the candidate's source range. The candidate's tokens are consecutive in the file's sequence.
- An entry in the exact sequence is the length of the token's spelling in UTF-16 code units, a colon, and the spelling. For example, `main` gives `4:main`.
- An entry in the similar sequence is the same as the exact entry, except that a token with a kind gives `!kind:`. For example, `main` gives `!identifier:`. A token without a kind keeps its exact entry.
- A fingerprint is the SHA-256 digest of the concatenated entries of the candidate's tokens, in base64url.
- The line count of a candidate is the number of code lines between its first and last token, inclusive. Lines with only comments or blanks are not code lines.

### Java, Ruby, PHP and Kotlin tokens

These languages use the same thresholds and fingerprints. The sequence omits comments and whitespace. The exact sequence keeps every other token's spelling. The similar sequence replaces identifiers and literals with their kind: strings, numbers, booleans and null. In Kotlin, an interpolated expression keeps its tokens. In PHP, the sequence also omits `<?php` tags and markup outside them.

Candidates are declarations, bodies, clauses and statements, and multi-line control flow or expressions.

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

A file that the parser cannot parse gets one diagnostic from `language-<id>/parse`. It gives the line and column of the first token the grammar rejects and, when the grammar knows it, the expected token. Lines and columns are 1-based. A Go column counts bytes, and a Python column counts characters. The operations that read the file's structure are recorded as blocked, with `Unavailable inputs: syntax`. The file stays in the inventory as not analysed, the inspection is partial, and the run goes on. For example:

```text
Expected ")" at line 2, column 8
Expected ":" or "->" at line 1, column 8
Unexpected syntax at line 3, column 9
```

A Go file must start with a package clause. Otherwise the diagnostic is `Expected a package clause at line 1, column 1`.

The parser differs from the compiler's own parser in these ways:

- Python 2 files, and Python nested deeper than CPython allows, are measured.
- A few valid but unusual files are rejected with a diagnostic. In test corpora, the grammars rejected 0% of Java and Ruby files, about 0.1% of PHP files, and about 1.4% of Kotlin files. Examples are PHP heredocs that contain `<?php`, and Kotlin suspend lambdas and some callable references.
- Duplication fingerprints depend on token-level formatting, such as a trailing comma or adjacent string literals.
- A very large file needs much memory: about 110 to 160 MB for each MiB of source in Go and Python. A 1 MiB file needs about 0.3 GB, and a 10 MiB file 1.1 to 1.6 GB. Expect similar growth in the other languages.

## Profile

An inspection records the plugins and grammars that took part. The profile covers:

- the language plugins that parsed at least one file;
- the grammars those plugins used, by name and version, such as `tree-sitter-go` `0.25.0` or `@tree-sitter-grammars/tree-sitter-kotlin` `1.1.0`;
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
