# Language provider metrics

A file provider accepts `sourceFile` and emits `codeStructure`. A repository provider accepts `sourceFiles` and emits `codeStructures`, an array with at most one structure per input path. Repometry marks a missing structure as an incomplete analysis of that file. These contracts are exported by `repometry/plugin`. The planner matches ports by contract ID. Input paths are relative to the repository root and use forward slashes.

- `lines` counts physical lines, including blank lines and comments. A final line terminator adds no line. `commentLines` counts lines containing only a comment or interpreter directive. `codeLines` or `clones.codeLines` lists distinct code lines in ascending order. A line with code and a comment counts as code.
- `functions` and `classes` count declarations and expressions the language recognizes. `cyclomaticFunctions` and `cognitiveFunctions` contain the separate scores for each measured function. Omit `name` for anonymous functions. For named Go methods use the receiver-qualified name, such as `UUID.String` or `(*UUID).String`. Python uses dotted class and function names, such as `Serializer.loads` or `Report.render.line`. Coordinates are 1-based. JS and TS columns count UTF-16 code units. A lexical parameter can contain a nested function, so the function count and the reported score arrays follow their own analysis rules.
- Optional `functionBodies` lists sorted, merged, 1-based inclusive line ranges for function bodies. An empty list means the provider found no body ranges. Omit the field when the provider cannot classify function bodies.
- `observations` carries raw counts and locations for the maintainability rules. The maintainability inspection applies the profile limits and computes remediation effort.
- `clones` carries candidate fingerprints, line ranges, and half-open source offsets. For JS and TS, candidates come from Babel subtrees. Exact fingerprints preserve identifiers and literals. Similar fingerprints normalize them. Compare fingerprints only within the same scheme.

Providers always report `path` and `lines`. A language can declare `measures` to select the optional facts it supplies. Missing facts leave the corresponding metrics unknown. Zero counts and empty arrays represent completed measurements. If a file lacks observations or clone data, the report records which rule groups were skipped. Repository totals require measurements from all selected source files. With intentionally unavailable rule inputs, maintainability can grade the measured subset. Both remediation effort and code lines use that subset, and `gradeCoverage` records the graded and total file counts. When no files supply the inputs for a grade, maintainability is unknown. A parse failure suppresses the partial grade.

The built-in JS and TS profile retains its algorithm definitions. Built-in metric IDs describe the measurement independently of the parser. When reading v2 reports and summaries, the six earlier `-babel` IDs resolve to the same metrics. A provider that measures a metric differently needs a distinct measurement definition before its results can be compared with this history.

## Technical debt

Repometry estimates technical debt as the minutes needed to fix the code smells it finds. The limits and costs are the same for every language, and no setting changes them. Each language counts the rule inputs its own way. [Go and Python analysis](native-languages.md#maintainability) describes those two.

A structural rule fires when its value is above the limit. Its finding costs a fixed number of minutes for each unit above the limit. Nested functions are measured on their own and don't add to the function that contains them.

| Rule | Value | Limit | Minutes per unit above the limit |
| --- | --- | --- | --- |
| `function-parameters` | Declared parameters of a function | 5 | 10 |
| `return-statements` | `return` statements in a function | 6 | 10 |
| `boolean-logic` | Logical operators in one expression | 4 | 10 |
| `nested-control-flow` | Deepest control-flow nesting in a function, or in the code outside functions | 4 | 20 |
| `function-complexity` | Cognitive complexity of a function | 15 | 10 |
| `file-complexity` | Cognitive complexity of a file | 50 | 5 |

A file's cognitive complexity includes its functions. So `file-complexity` charges only what the `function-complexity` findings haven't: its units above 50, minus the units by which the file's functions exceed 15 in total, and never less than zero. When nothing is left, the finding stays in the report with zero minutes.

A `try` statement adds no nesting level and no complexity: its block and its `finally` block stay at the depth of the statement. A `catch` clause, or `except` in Python, is a nesting level and adds one plus its depth to cognitive complexity. A `try` with a `catch` at the top of a function therefore has a control-flow depth of 1 and adds 1 to the function's complexity.

The duplication rules `identical-code` and `similar-code` compare repeated syntax subtrees of at least 50 nodes and 12 code lines. Occurrences match when their similar fingerprints match, which ignores names and literals. The finding is `identical-code` when their exact fingerprints match too, and `similar-code` otherwise. Larger subtrees are matched first, and an occurrence that overlaps one already matched is dropped. A group needs two occurrences left. The first occurrence, by path and then position, costs nothing. Each other occurrence costs 2 minutes per code line. The finding sits in the first occurrence's file with its whole cost, and lists the other occurrences in `related`.

Every rule finding has the level `medium`, and the level doesn't change the cost. Each finding records `value`, its `effortMinutes`, and for structural rules the `limit`. A file's effort is the sum of its findings' minutes, and the repository's effort is the sum over its files. Only findings of the `structure` and `duplication` categories count, which are the findings of the rules above. Imported lint findings and security findings, of the categories `security`, `dependency`, `secret` and `infrastructure`, add no effort. Findings that an `ignore` rule in `repometry.config.json` matches move to `ignoredFindings` and add no effort either.

## Debt ratio and grades

The debt ratio divides the effort by an estimate of the time to write the code:

```text
debt ratio       = effort minutes / development cost
development cost = 2.4 × (code lines / 1000) ^ 1.05 × 9600 minutes
```

This is the basic COCOMO estimate for organic projects, 2.4 × KLOC^1.05 person-months, at 9,600 minutes (160 hours) per person-month. The report names it `basic-cocomo-organic`. Code lines are the `repometry.code-lines/v1` measurement: nonblank lines without comment-only lines and the interpreter directive. Without code lines there is no ratio.

The effort and the code lines cover the same files: every source file a language claims, test files included. Repometry leaves out the `.git`, `.repometry`, `node_modules` and `target` folders, the paths matching `**/.yarn`, `**/.pnp.{js,cjs,loader.mjs}`, `**/vendor`, `**/third_party`, `**/*.min.{js,cjs,mjs}` and `**/*{.,-}bundle.{js,cjs,mjs}`, and the paths in `exclude`. It also leaves out generated files: a file that ends with a source map comment, or a file of at least 1,024 bytes whose nonblank lines average more than 300 characters. When some files have no rule inputs, both use the measured subset described above.

The maintainability grade follows from the ratio. The security grade follows from the worst finding of the categories `security`, `dependency`, `secret` and `infrastructure`.

| Grade | Maintainability: debt ratio | Security: worst finding |
| --- | --- | --- |
| A | below 5% | no finding |
| B | 5% to below 10% | `low` or `unknown` |
| C | 10% to below 20% | `medium` |
| D | 20% to below 50% | `high` |
| F | 50% or more | |

Findings have the levels `low`, `medium`, `high` and `unknown`, so the security grade runs from A to D. An inspection has a security grade only when a security scanner plugin ran or the configuration imports findings of one of those categories. A commit's summary row records `smells`, `effortMinutes`, `debtRatio` and `grade` under `quality.maintainability`.

For example, a function with 7 parameters and a cognitive complexity of 22 sits in a file with a cognitive complexity of 60:

| Finding | Value | Limit | Units charged | Minutes |
| --- | --- | --- | --- | --- |
| `function-parameters` | 7 | 5 | 2 | 2 × 10 = 20 |
| `function-complexity` | 22 | 15 | 7 | 7 × 10 = 70 |
| `file-complexity` | 60 | 50 | 10 − 7 = 3 | 3 × 5 = 15 |

The file's effort is 105 minutes. The repository has 2,000 code lines and one more finding: a block of 20 code lines in three places, which costs 2 copies × 20 lines × 2 minutes = 80 minutes. The effort is 185 minutes. The development cost is 2.4 × 2^1.05 × 9600 ≈ 47,705 minutes, so the debt ratio is 185 / 47,705 ≈ 0.39% and the grade is A. Grade B would start at 2,386 minutes of effort.

A report records the limits, costs and debt model it used under `appliedConfig.maintainability`, and each finding keeps its `effortMinutes`. Repometry computes a saved report's ratio with the debt model that report records, and reads the summary row's `debtRatio` and `grade` back as saved. A saved report keeps the numbers of the version that made it.

## Coverage counts

Each file in `repometry.lcov-lines/v1` can include `functionCalls`, a list of `[declarationLine, calls]` pairs ordered by line. The importer reads LCOV records. It converts Go blocks and Cobertura classes and methods to the same records first. It pairs function declarations and calls by name and occurrence within each record and sums matching call counts. Multiple declarations can share a line. A zero represents a recorded count of zero.

The importer filters these records by the provider's code-line classification when available. Otherwise it counts the valid lines the records report for the analysed file. `functionBodies` carries the provider's body ranges. A source gutter can display `functionCalls` on declaration lines and show raw line hit numbers inside body ranges. At module level, the raw hit count can represent module loads.

## Declaring metrics and products

A plugin manifest declares its `kinds`, optional file `claims`, and every product its operations return. Use the contracts exported by `repometry/plugin` for source files, structure facts, measurements, and findings. The `report` persistence class saves measurements, findings, and custom products. The report also keeps the rules each plugin declares. Custom products declare a JSON Schema so the engine can validate the output and store the contract with it. Transient products feed other operations during analysis.

Pass trusted in-process plugins as `plugins` in the `inspect` request. The default executor receives text files matching their claims after the source adapter applies exclusions. A Git working tree includes tracked files and untracked files permitted by Git's ignore rules. With a separately configured executor, register its plugins directly. When supplying your own snapshot, pass the plugins as the second argument to `analyzeSnapshot`.

Language plugins define the source file set through their claims. Each file uses its matching provider for structure and maintainability measurements. Overlapping language-provider claims produce an error naming the file and providers. The report records each distinct operation binding it used.

Use `providesLanguages` to declare a language's ID, display label, optional six-digit hexadecimal color, and file extensions or globs. These declarations select source files. Reports store the language catalog once and record the selected provider operation for each source path. The viewer colours each language's source from its declared `syntax`.

Pass the same language plugins to `inspect` and `measureDiffCoverage` so they select the same source paths.

The Git inventory also records regular tracked files after exclusions. Binary or unavailable files have an unknown line count.

Each report defines its own metric catalog. The repository summary lifts these catalogs into a single history catalog and remaps the commit values. A standalone detail asset includes its own catalog, so a summary and a detail join by metric ID. Measured values can be zero or null. An omitted metric index in a commit means it was unmeasured. An omitted file value for a measured metric means zero for a file in scope. Explicit nulls mark metrics that require provider facts unavailable for a file or aggregate. Ratios specify numerator and denominator IDs and roll up as a ratio of sums.

## Reusing operation results

Use `persistence: 'cache'` for deterministic products whose operations depend only on their input data, effective configuration, and declared toolchain. `inspect` accepts `operationCache` with a `store` and a `configurationDigest`. The digest should identify any effective settings that the input products do not carry. `LocalOperationCache` from `repometry/plugin` writes atomically to a caller-selected directory such as `.repometry/cache/operations`.

Cache entries are keyed by the operation, versions, bindings, configuration digest, and complete input values, including source bytes and paths. Plain records, arrays, primitives, and byte arrays are supported. A miss, invalid entry, or unsupported input runs the operation normally. Cache products feed downstream operations during inspection and are stored separately from reports.

## Running external tools

`DockerToolRunner` from `repometry/plugin` runs an argument vector in a caller-selected local Docker image. It mounts the supplied file snapshot read-only at `/snapshot`, sets `HOME` to a writable temporary filesystem at `/tmp`, disables networking, and leaves host environment variables out of the tool invocation. The caller supplies a deadline and a combined output limit and can set memory and process limits. The result contains the exit code, stdout, and stderr for the plugin to interpret.

`processPlugin(manifest, runner)` adapts commands to the same plugin API as in-process inspections. Declare each command's inputs, output contract, arguments, deadline, output limit, and tool versions in the manifest. The runner sends one JSON request on stdin using `repometry.plugin-process/v1`. It includes the operation ID, effective `settings`, and named inputs with contract IDs. Source file inputs are references with `path` and `sha256`, and the original bytes are available at those paths relative to the tool's working directory. Other input products are passed as JSON values.

Use `scope: 'repository'` and the `sourceFiles` input contract for a tool that needs a whole module. The operation runs once over the plugin's matching files, and the port lists those file references in its `files` field. Its result can contain data for multiple files. Register process plugins through the npm API or [configure them in the CLI](process-plugins.md).

The command writes JSON Lines to stdout. Return exactly one product record with `kind: "product"`, its declared `contract`, and `value`. An optional diagnostic record has `kind: "diagnostic"`, a `message`, and an optional `severity` of `info`, `warning`, or `error`. Info leaves the result status unchanged. A warning keeps valid results and marks the inspection partial. An error or nonzero exit fails the operation. Effective settings and tool versions are recorded in the report. Use versioned images or image digests for repeatable tools.
