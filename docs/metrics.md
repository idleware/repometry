# Language provider metrics

A file provider accepts `sourceFile` and emits `codeStructure`. A repository provider accepts `sourceFiles` and emits `codeStructures`, an array with at most one structure per input path. Repometry marks a missing structure as an incomplete analysis of that file. These contracts are exported by `repometry/plugin`. The planner matches ports by contract ID. Input paths are relative to the repository root and use forward slashes.

- `lines` counts physical lines, including blank lines and comments. A final line terminator adds no line. `commentLines` counts lines containing only a comment or interpreter directive. `codeLines` or `clones.codeLines` lists distinct code lines in ascending order. A line with code and a comment counts as code.
- `functions` and `classes` count declarations and expressions the language recognizes. `cyclomaticFunctions` and `cognitiveFunctions` contain the separate scores for each measured function. Omit `name` for anonymous functions. For named Go methods use the receiver-qualified name, such as `UUID.String` or `(*UUID).String`. Python uses dotted class and function names, such as `Serializer.loads` or `Report.render.line`. Coordinates are 1-based. JS and TS columns count UTF-16 code units. A lexical parameter can contain a nested function, so the function count and the reported score arrays follow their own analysis rules.
- Optional `functionBodies` lists sorted, merged, 1-based inclusive line ranges for function bodies. An empty list means the provider found no body ranges. Omit the field when the provider cannot classify function bodies.
- `observations` carries raw counts and locations for the maintainability rules. The maintainability inspection applies the profile limits and computes remediation effort.
- `clones` carries candidate fingerprints, line ranges, and half-open source offsets. For JS and TS, candidates come from Babel subtrees. Exact fingerprints preserve identifiers and literals. Similar fingerprints normalize them. Compare fingerprints only within the same scheme.

Providers always report `path` and `lines`. A language can declare `measures` to select the optional facts it supplies. Missing facts leave the corresponding metrics unknown. Zero counts and empty arrays represent completed measurements. If a file lacks observations or clone data, the report records which rule groups were skipped. Repository totals require measurements from all selected source files. With intentionally unavailable rule inputs, maintainability can grade the measured subset. Both remediation effort and code lines use that subset, and `gradeCoverage` records the graded and total file counts. When no files supply the inputs for a grade, maintainability is unknown. A parse failure suppresses the partial grade.

The built-in JS and TS profile retains its algorithm definitions. Built-in metric IDs describe the measurement independently of the parser. When reading v2 reports and summaries, the six earlier `-babel` IDs resolve to the same metrics. A provider that measures a metric differently needs a distinct measurement definition before its results can be compared with this history.

## Coverage counts

Each file in `repometry.lcov-lines/v1` can include `functionCalls`, a list of `[declarationLine, calls]` pairs ordered by line. The importer pairs LCOV declarations and calls by name and occurrence within each record and sums matching call counts. Multiple declarations can share a line. A zero represents a recorded count of zero.

The importer filters LCOV records by the provider's code-line classification when available. Otherwise it counts the valid lines reported by LCOV for the analysed file. `functionBodies` carries the provider's body ranges. A source gutter can display `functionCalls` on declaration lines and show raw line hit numbers inside body ranges. At module level, the raw hit count can represent module loads.

## Declaring metrics and products

A plugin manifest declares its `kinds`, optional file `claims`, and every product its operations return. Use the contracts exported by `repometry/plugin` for source files, structure facts, measurements, and findings. The `report` persistence class saves measurements, findings, and custom products. The report also keeps the rules each plugin declares. Custom products declare a JSON Schema so the engine can validate the output and store the contract with it. Transient products feed other operations during analysis.

Pass trusted in-process plugins as `plugins` in the `inspect` request. The default executor receives text files matching their claims after the source adapter applies exclusions. A Git working tree includes tracked files and untracked files permitted by Git's ignore rules. With a separately configured executor, register its plugins directly. When supplying your own snapshot, pass the plugins as the second argument to `analyzeSnapshot`.

Language plugins define the source file set through their claims. Each file uses its matching provider for structure and maintainability measurements. Overlapping language-provider claims produce an error naming the file and providers. The report records each distinct operation binding it used.

Use `providesLanguages` to declare a language's ID, display label, optional six-digit hexadecimal color, and file extensions or globs. These declarations select source files. Reports store the language catalog once and record the selected provider operation for each source path.

Pass the same language plugins to `inspect` and `measureDiffCoverage` so they select the same source paths. Worker input validation uses the source selector configured on the worker. The CLI's `worker` command and `--worker` option select JS, TS, Go and Python files.

The Git inventory also records regular tracked files after exclusions. Binary or unavailable files have an unknown line count.

Each report defines its own metric catalog. The repository summary lifts these catalogs into a single history catalog and remaps the commit values. A standalone detail asset includes its own catalog, so a summary and a detail join by metric ID. Measured values can be zero or null. An omitted metric index in a commit means it was unmeasured. An omitted file value for a measured metric means zero for a file in scope. Explicit nulls mark metrics that require provider facts unavailable for a file or aggregate. Ratios specify numerator and denominator IDs and roll up as a ratio of sums.

## Reusing operation results

Use `persistence: 'cache'` for deterministic products whose operations depend only on their input data, effective configuration, and declared toolchain. `inspect` accepts `operationCache` with a `store` and a `configurationDigest`. The digest should identify any effective settings that the input products do not carry. `LocalOperationCache` from `repometry/report` writes atomically to a caller-selected directory such as `.repometry/cache/operations`.

Cache entries are keyed by the operation, versions, bindings, configuration digest, and complete input values, including source bytes and paths. Plain records, arrays, primitives, and byte arrays are supported. A miss, invalid entry, or unsupported input runs the operation normally. Cache products feed downstream operations during inspection and are stored separately from reports.

## Running external tools

`DockerToolRunner` from `repometry/plugin` runs an argument vector in a caller-selected local Docker image. It mounts the supplied file snapshot read-only at `/snapshot`, sets `HOME` to a writable temporary filesystem at `/tmp`, disables networking, and leaves host environment variables out of the tool invocation. The caller supplies a deadline and a combined output limit and can set memory and process limits. The result contains the exit code, stdout, and stderr for the plugin to interpret.

`processPlugin(manifest, runner)` adapts commands to the same plugin API as in-process inspections. Declare each command's inputs, output contract, arguments, deadline, output limit, and tool versions in the manifest. The runner sends one JSON request on stdin using `repometry.plugin-process/v1`. It includes the operation ID, effective `settings`, and named inputs with contract IDs. Source file inputs are references with `path` and `sha256`, and the original bytes are available at those paths relative to the tool's working directory. Other input products are passed as JSON values.

Use `scope: 'repository'` and the `sourceFiles` input contract for a tool that needs a whole module. The operation runs once over the plugin's matching files, and the port lists those file references in its `files` field. Its result can contain data for multiple files. Register process plugins through the npm API or [configure them in the CLI](process-plugins.md).

The command writes JSON Lines to stdout. Return exactly one product record with `kind: "product"`, its declared `contract`, and `value`. An optional diagnostic record has `kind: "diagnostic"`, a `message`, and an optional `severity` of `info`, `warning`, or `error`. Info leaves the result status unchanged. A warning keeps valid results and marks the inspection partial. An error or nonzero exit fails the operation. Effective settings and tool versions are recorded in the report. Use versioned images or image digests for repeatable tools.
