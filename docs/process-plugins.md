# Configure a process language plugin

[Write a plugin](plugins.md) gives the rules for all plugins, including the errors. Build the parser into a local Docker image. Use the full image ID from `docker image inspect --format '{{.Id}}' IMAGE` or a repository digest already present on the machine.

Add a language plugin to `repometry.config.json`. Replace the example image ID with yours.

```json
{
  "plugins": [
    {
      "id": "fixture",
      "version": "1.0.0",
      "image": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "command": ["node", "/tools/fixture.cjs"],
      "scope": "repository",
      "tools": { "node": "26.13.0" },
      "providesLanguages": [
        {
          "id": "fixture", "label": "Fixture", "color": "#123456", "extensions": [".fixture"],
          "syntax": { "lineComments": ["#"], "strings": [{ "quote": "\"" }], "keywords": ["let", "end"] }
        }
      ]
    }
  ]
}
```

```sh
npx repometry plugins
npx repometry analyze
npx repometry report html
```

A single-language plugin can put its `extensions` and `globs` in `claims` instead of under the language. A plugin with multiple languages specifies the selectors under each language. Top-level selectors that a plugin also lists must match the combined selectors of its languages. Assign a unique ID to each plugin. An ID that a built-in plugin uses is an error; [Process plugin failures](plugins.md#process-plugin-failures) lists the messages. [Process plugin configuration schema](../packages/repometry/src/main/resources/config/process-plugins-v1.schema.json).

A language ID may match one that another plugin provides, such as `go` or `javascript`. Then the config needs a `parsers` entry that chooses the parser; see [Parsers](cli.md#parsers).

A language's optional `measures` array accepts `functions`, `cyclomaticComplexity`, `cognitiveComplexity`, `classes`, `commentLines`, `codeLines`, `duplication`, and `structuralRules`. Include only capabilities the parser supplies. A parser that counts functions and decisions declares `["functions", "cyclomaticComplexity"]` and returns `path`, `lines`, `functions`, and `cyclomaticFunctions`. Duplication requires `codeLines` and clone candidates. Structural rules consume `observations`. See [Language provider metrics](metrics.md) for unknown values and repository rollups.

A language's optional `syntax` tells the report viewer how to colour its source. It is data for a scanner, not a grammar, and every field is optional. Repometry attaches it when it renders a report and does not save it in the store. A language without `syntax` is shown as plain text. The data cannot express string interpolation or nested comments.

| Field | Value |
| --- | --- |
| `lineComments` | Markers that start a comment running to the end of the line, such as `//` or `#`. |
| `blockComments` | Pairs of start and end markers, such as `["/*", "*/"]`. A block comment can span lines. |
| `strings` | String forms. Each has a `quote` and optional `multiline` and `raw` booleans. A string ends at the quote that opened it. A backslash escapes the next character unless the form is `raw`. A form that is not `multiline` ends at the end of the line. |
| `stringPrefixes` | Letters that can stand right before a quote and belong to the string, such as `r`, `b`, or `rb`. Compared without case. |
| `keywords` | Words shown as keywords, including literals such as `true`. At most 512. Compared with case. |
| `regexAfter` | Words after which a slash opens a regular-expression literal. Without it a slash is plain. |

A marker or quote is a string of 1 to 8 characters with no whitespace. A word starts with a letter, `_`, or `$`, and continues with letters, digits, `_`, or `$`.

Set `"fileIndependent": true` for a repository parser if each file produces the same results and diagnostics when other files are omitted. During a local revision range, Repometry can send only changed files to a provider with a transient structure output and no repository inspection operations. Keep the default `false` for parsers that rely on other files or repository-wide context.

Optional `limits` fields are `timeoutMs`, `maxOutputBytes`, `memoryBytes`, and `pidsLimit`. Defaults are 30 seconds, 8 MiB of output, 512 MiB of memory, and 128 processes. The runner uses a read-only snapshot and disables networking. Configured plugins run with local analysis. [Process plugin failures](plugins.md#process-plugin-failures) describes the sandbox, the exit codes and the limits.

## Input and output

The process reads one JSON request from stdin using protocol `repometry.plugin-process/v1`. Its `operation` is the plugin ID followed by `/parse`. Its `settings` value comes from the configuration.

- Repository scope runs once for the selected files. Read references from `inputs.files.files` and emit an array using contract `repometry.code-structures/v1`.
- File scope runs once per selected file. Read the reference from `inputs.source.file` and emit one object using contract `repometry.code-structure/v1`.

A reference carries a repository-relative `path` and its SHA-256 hash. Read the file at that path relative to the process working directory.

Write exactly one JSON Lines record to stdout with `kind: "product"`, the contract ID, and `value`. Optional records with `kind: "diagnostic"` carry a message and a severity of `info`, `warning`, or `error`. A warning preserves valid results and marks the run partial. An error fails the operation. A nonzero exit code, a timeout or a second product also fails it; see [Process plugin failures](plugins.md#process-plugin-failures).

This is the repository-scoped `/tools/fixture.cjs` for the example. The fixture format has code on nonblank lines and has no functions, comments, or classes.

```js
const fs = require('node:fs');
const { inputs } = JSON.parse(fs.readFileSync(0, 'utf8'));

const value = inputs.files.files.map(({ path }) => {
  const text = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const codeLines = lines.flatMap((line, index) => line.trim() ? [index + 1] : []);
  return {
    path,
    lines: lines.length,
    functions: 0,
    classes: 0,
    commentLines: 0,
    cognitiveComplexity: 0,
    cyclomaticFunctions: [],
    cognitiveFunctions: [],
    observations: [],
    clones: { path, codeLines, candidates: [] },
  };
});

console.log(JSON.stringify({ kind: 'product', contract: 'repometry.code-structures/v1', value }));
```
