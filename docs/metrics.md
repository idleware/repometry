# Language provider metrics

A provider accepts `sourceFile` and emits `codeStructure`. Both contracts are exported by `repometry/plugin`. The planner matches ports by contract ID. The input path is relative to the repository root and uses forward slashes.

- `lines` counts physical lines, including blank lines and comments. A final line terminator adds no line. `commentLines` counts lines containing only a comment or interpreter directive. `clones.codeLines` lists distinct code lines in ascending order. A line with code and a comment counts as code.
- `functions` and `classes` count declarations and expressions the language recognizes. `cyclomaticFunctions` and `cognitiveFunctions` contain the separate scores for each measured function. Coordinates are 1-based. JS and TS columns count UTF-16 code units. A lexical parameter can contain a nested function, so the function count and the reported score arrays follow their own analysis rules.
- `observations` carries raw counts and locations for the maintainability rules. The maintainability inspection applies the profile limits and computes remediation effort.
- `clones` carries candidate fingerprints, line ranges, and half-open source offsets. For JS and TS, candidates come from Babel subtrees. Exact fingerprints preserve identifiers and literals. Similar fingerprints normalize them. Compare fingerprints only within the same scheme.

The built-in JS and TS profile retains its existing metric IDs and algorithm definitions. A provider that measures a metric differently needs a distinct measurement definition before its results can be compared with this history.

## Declaring metrics and products

A plugin manifest declares its `kinds`, optional file `claims`, and every product its operations return. A planner request can explicitly opt a pre-manifest plugin into compatibility mode by naming it in `legacyPluginIds`. Use the contracts exported by `repometry/plugin` for source files, structure facts, measurements, and findings. The `report` persistence class saves measurements, rules, and custom products. Custom products declare a JSON Schema so the engine can validate the output and store the contract with it. Transient products feed other operations during analysis. Cache declarations reserve the routing contract for the cache adapter.

Pass additional in-process plugins as the second argument to `analyzeSnapshot`. The built-in Git and working-tree adapters currently supply JS and TS sources for analysis. The Git inventory also records regular tracked files after exclusions. Binary or unavailable files have an unknown line count.

Each report defines its own metric catalog. The repository summary lifts these catalogs into a single history catalog and remaps the commit values. A standalone detail asset includes its own catalog, so a summary and a detail join by metric ID. Measured values can be zero or null. An omitted metric index in a commit means it was unmeasured. An omitted file value for a measured metric means zero for a file in scope. Ratios specify numerator and denominator IDs and roll up as a ratio of sums.
