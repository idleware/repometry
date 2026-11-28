# Docker plugins

A Docker plugin is a plugin whose code runs in a container. [Write a plugin](plugins.md) describes what all plugins share: the manifest fields, the categories, the options and the requirements. This page covers what is specific to Docker: how the plugin describes itself, how Repometry finds the image, the request and the response, and the sandbox.

A Docker plugin is one of two things:

| Form | Reference in the config | The manifest lives in |
| --- | --- | --- |
| An image that describes itself | `docker:IMAGE` | The `repometry.plugin` label of the image. |
| A manifest file | `./plugin.json` | The `.json` file, which also names the `image`. |

The label form needs Docker even to read the manifest. The file form can be read without Docker.

## The manifest file

A Docker manifest follows the [plugin manifest schema](../packages/core/src/main/resources/plugin-v1.schema.json). The fields of [Write a plugin](plugins.md#the-manifest) apply: `schema`, `id`, `version`, `category`, `include`, `exclude`, `languages`, `optionsSchema`, `requires` and `checks`. A Docker plugin has no `create` function. These fields describe how to run it:

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | The plugin's version. |
| `command` | yes | The command to run in the container, as a list. The first element is the executable, and the others are its arguments. |
| `scope` | yes | `file` runs the command once for each selected file. `repository` runs it once for all of them. |
| `tools` | yes | The executables the command uses and their versions, such as `{ "node": "26" }`. At least one. Repometry saves them with the inspection. Use exact versions, and a versioned image or a digest, so that a rerun uses the same tools. |
| `image` | only in a `.json` file | The local image to run: a tag, an image ID, or a repository digest. A label must not have it, because the label belongs to the image. |
| `fileIndependent` | no | `true` if each file produces the same results and diagnostics when other files are omitted. Keep the default `false` for parsers that rely on other files or on the whole repository. |
| `limits` | no | See [Limits and the sandbox](#limits-and-the-sandbox). |

A Docker plugin has the category `language`, `maintainability` or `security`. A `language` plugin has one operation, `parse`, whose output is a code structure. The other plugins have one operation, `inspect`, whose output is findings and measurements. Set `"fileIndependent": true` for a repository parser that meets the condition above. During a local revision range, Repometry can then send only the changed files to the plugin.

A Docker plugin always requires the `docker` command, in addition to the `requires` it declares. Without Docker, a plugin from a `.json` manifest is unavailable with the reason `required executable docker is not on PATH`.

### Label

An image carries its manifest, without `image`, as one line of JSON in the label `repometry.plugin`.

```dockerfile
FROM node:26-alpine
COPY fixture.cjs /tools/fixture.cjs
LABEL repometry.plugin='{"schema":"urn:repometry:schema:plugin:1","id":"fixture","version":"1.0.0","category":"language","command":["node","/tools/fixture.cjs"],"scope":"repository","tools":{"node":"26"},"languages":[{"id":"fixture","label":"Fixture","color":"#123456","include":["**/*.fixture"],"syntax":{"lineComments":["#"],"keywords":["let","end"]}}]}'
```

Reference the image in the config. The Docker daemon must already have it:

```json
{ "plugins": ["docker:repometry-doc-fixture:1"] }
```

### File

A manifest file adds `image`. Use it when you do not control the image, or when you want to keep the manifest in your repository.

```json
{
  "schema": "urn:repometry:schema:plugin:1",
  "id": "fixture",
  "version": "1.0.0",
  "category": "language",
  "image": "repometry-doc-fixture:1",
  "command": ["node", "/tools/fixture.cjs"],
  "scope": "repository",
  "tools": { "node": "26" },
  "languages": [
    { "id": "fixture", "label": "Fixture", "color": "#123456", "include": ["**/*.fixture"] }
  ]
}
```

Reference the file by its path, which resolves against the folder of the config file:

```json
{ "plugins": [{ "use": "./plugins/fixture.json" }] }
```

## Tags and image IDs

Repometry never pulls an image. It runs `docker run --pull never`, so the image must be on the machine.

- For `docker:IMAGE`, Repometry runs `docker image inspect` to read the label and the image ID.
- For a `.json` manifest, Repometry resolves `image` to an image ID with `docker image inspect`, without running the image. An `image` that is already an image ID or a repository digest, such as `name@sha256:...`, is used as it is.
- Repometry runs the image ID, not the tag. It records the ID in the applied configuration of the report, as `image` in the plugin's entry. Moving a tag to another image changes the ID, so the inspection gets a new profile, and the viewer marks it in Trends.

Use an image ID or a repository digest in a manifest if you want every machine to run the same bytes.

Language plugins can share a language ID with another plugin, such as `go` or `javascript`. Then the config needs a `parsers` entry that chooses the parser; see [Parsers](cli.md#parsers).

## The request

Repometry starts the command in the container and writes one JSON object, ending with a newline, to its stdin. A plugin must ignore request fields that it does not know.

```json
{
  "schema": "urn:repometry:schema:plugin-request:1",
  "operation": "fixture/parse",
  "options": null,
  "files": [{ "path": "a.fixture", "sha256": "..." }],
  "inputs": { "files": { "contract": "repometry.source-files/v1", "files": [{ "path": "a.fixture", "sha256": "..." }] } }
}
```

| Field | Meaning |
| --- | --- |
| `schema` | Always `urn:repometry:schema:plugin-request:1`. |
| `operation` | The plugin ID, a `/`, and `parse` for a `language` plugin or `inspect` for another. |
| `options` | The options from the config entry. `null` when the plugin declares no `optionsSchema`. |
| `files` | A reference for every file in `inputs`. |
| `inputs` | The inputs of the operation. A repository plugin gets `inputs.files.files`. A file plugin gets `inputs.source.file`. |

A reference has the repository-relative `path` of a file and its SHA-256 hash. Read the file at that path, relative to the process's working directory.

## The response

Write JSON Lines to stdout, one object on each line.

- Exactly one record with `kind: "product"`, the `contract` ID and the `value`.
- Optional records with `kind: "diagnostic"`, with a `message` and a `severity` of `info`, `warning` or `error`. A warning keeps the valid results and marks the run partial. An error fails the operation.

The contract and the value depend on the plugin:

| Plugin | `contract` | `value` |
| --- | --- | --- |
| `language`, scope `repository` | `repometry.code-structures/v1` | An array with a code structure for each file. |
| `language`, scope `file` | `repometry.code-structure/v1` | One code structure. |
| `maintainability` or `security` | `repometry.findings-and-measurements/v1` | An object with `measurements` and `findings`. |

[Language provider metrics](metrics.md) describes a code structure. A structural observation names its check in `check`. A finding has a `check`, and a `plugin` that, when present, is the plugin's own ID. [Write a plugin](plugins.md#checks) lists the fields of a finding.

A language's optional `measures` array accepts `functions`, `cyclomaticComplexity`, `cognitiveComplexity`, `classes`, `commentLines`, `codeLines`, `duplication`, and `checks`. Include only capabilities the parser supplies. A parser that counts functions and decisions declares `["functions", "cyclomaticComplexity"]` and returns `path`, `lines`, `functions`, and `cyclomaticFunctions`. Duplication requires `codeLines` and clone candidates. Structural checks consume `observations`. See [Language provider metrics](metrics.md) for unknown values and repository rollups.

### Syntax

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

## Limits and the sandbox

Optional `limits` fields are `timeoutMs`, `maxOutputBytes`, `memoryBytes`, and `pidsLimit`. Each is a positive integer. Defaults are 30 seconds, 8 MiB of output, 512 MiB of memory, and 128 processes.

The sandbox is fixed, and a manifest cannot change it. The command runs from a local image with `docker run --rm --pull never`. It has no network, a read-only root file system, no capabilities and `no-new-privileges`. The user is the caller's user and group. `/tmp` is a writable temporary file system, and `HOME` is `/tmp`. Proxy variables are empty. The input files are mounted read-only at `/snapshot`, which is the working directory. The image entrypoint is replaced by the first element of `command`, and the other elements are its arguments. The limits `memoryBytes` and `pidsLimit` apply. The files that the request names are the only files in the snapshot.

A Docker plugin runs with local analysis. Options reach the container as part of the request and are saved with the inspection, so put no secret in them.

## Failures

A run fails in these ways. The report records the failure as a diagnostic, and the analysis goes on.

| Cause | Message |
| --- | --- |
| A nonzero exit code | `Process plugin exited with code <n>`, followed by the last three non-empty lines of stderr. Repometry cuts each line to 240 characters. It replaces a line that looks like a credential assignment with `[redacted tool output]`, and it hides credentials in URLs and token-like strings. It does not read stdout. |
| Exit codes 125, 126 and 127 | `Docker could not start the tool (exit code <n>)`. A plugin that exits with one of these codes gets this message too. |
| `timeoutMs` passes | `Tool timed out`. Repometry kills the process with `SIGKILL`. |
| stdout and stderr together exceed `maxOutputBytes` | `Tool exceeded the output limit` |
| A stdout line is not a JSON object | `Invalid JSON Lines output from the process plugin` or `Invalid process plugin output record` |
| The output holds a second product, another contract or an unknown `kind` | `Expected one declared product from the process plugin` |
| The output holds no product | `Missing declared product from the process plugin` |
| The value does not pass the contract | `Invalid output for <contract>`. A finding with `rule` or `tool` instead of `check` causes this. |
| A `diagnostic` record has no `message` | `Invalid process plugin diagnostic message` |
| A `diagnostic` record has another severity | `Invalid process plugin diagnostic severity` |
| An `error` diagnostic | The operation fails with the message of the record. |
| An input that is not JSON data | `Process input must be JSON data: <plugin>/<operation>.<port>` |

Blank lines in stdout are ignored. A diagnostic with no `severity`, or with `info`, is ignored. A `warning` records a warning without a path.

The errors for the manifest and the reference are in [Plugins](cli.md#plugins) and in [Write a plugin](plugins.md#errors). A manifest that lacks a field that Docker plugins need gives one of these messages:

| Message | Meaning |
| --- | --- |
| `plugins/<n>/manifest/version is required` | A Docker manifest has no `version`. |
| `plugins/<n>/manifest/command/0 must name an executable` | `command` is missing, or its first element is empty. |
| `plugins/<n>/manifest/scope is required` | The manifest has no `scope`. |
| `plugins/<n>/manifest/tools must identify executable versions` | `tools` is missing or empty. |
| `plugins/<n>/manifest/image is required` | A `.json` manifest has no `image`. |
| `plugins/<n>/manifest/image belongs in a manifest file` | A label has an `image`. |

## Example

This image parses a made-up language, `fixture`, whose files end in `.fixture`. Its code is on nonblank lines. It has no functions, comments or classes. The repository-scoped `/tools/fixture.cjs` reads the request and writes one product:

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

Build the image with the Dockerfile above, then run the plugin:

```sh
docker build -t repometry-doc-fixture:1 .
npx repometry plugins
npx repometry analyze --working-tree
npx repometry report html
```

`repometry plugins` lists the plugin with `"use": "docker:repometry-doc-fixture:1"`, `"versionSource": "manifest"` and the language `fixture`. The inspection reports the plugin's image ID as `image` in its applied configuration.
