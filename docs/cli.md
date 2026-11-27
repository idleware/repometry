# Commands and settings

This page covers the rules that settings follow, the `projects` command, the `components` and `parsers` keys, exit codes and the environment variables that the [README](../README.md#usage) leaves out. [Reading inspections](store.md#reading-inspections) describes `history` and `show`.

## Analysis settings

- `analyze` with no revision analyses `HEAD`. Use `analyze REVISION` to analyse another commit, or `--working-tree` for the working directory.
- `--branch NAME` on `report` and `view`, or `branch` in `repometry.config.json`, only names the branch the report shows. It never selects a commit.
- An option given on the command line replaces the same key in `repometry.config.json`; the config's value is not merged with it. This holds for `--import` and `imports`, `--exclude` and `exclude`, `--branch` and `branch`, `--sources` and `sources`, and for the formats typed after `report` and `reports`. `--no-config` skips the config file.
- `analyze BASE..HEAD` rejects `--import`, because an import describes one checkout. It skips the config's `imports` and says so on stderr.
- A path typed on the command line resolves against the folder the command runs in, or against `--repo DIR` (`-C DIR`) on a command that takes it. This covers `--import`, `--store`, `--config` and the path in `report FORMAT=PATH`. A path in `repometry.config.json` resolves against the repository root, wherever the command runs. This covers the paths in `imports` and `reports`.
- A command takes `--repo` and `--store` only when it uses them. `analyze`, `show`, `history`, `report` and `store check` take both. `review` and `plugins` take `--repo`. `view` takes `--store`, and its `TARGET` says where to look. `projects` and `cache` take neither. Any other command rejects the option as unknown.

`--import FORMAT=PATH` and the `imports` key take these formats. Repeat `--import` for each file. `--import-root DIR` resolves the paths in scanner reports and does not apply to coverage.

| Format | File |
| --- | --- |
| `lcov` | LCOV coverage. |
| `go-cover` | Go coverprofile from `go test -coverprofile`. |
| `cobertura` | Cobertura XML coverage, such as `coverage.xml`. See [Importing coverage](native-languages.md#importing-coverage). |
| `sarif` | SARIF lint findings. |
| `sarif-security` | SARIF security findings. |
| `sarif-secrets` | SARIF secret findings. |
| `eslint` | ESLint JSON output. |
| `osv` | OSV-Scanner JSON output. |

## Projects index

`repometry projects DIR` builds an index page for a folder of exported reports and writes it into `DIR`. Without `DIR` it uses the current folder. Each subfolder that holds an `index.html` and a valid `summary.json`, as `repometry report html=DIR/NAME` writes them, becomes an entry.

```sh
repometry report html=sites/app --store .repometry
repometry projects sites
```

## Components

Components group files by path, so the report can total each group. Define them in the `components` key of `repometry.config.json`. Repometry reads no other file for them, so a `.repometry/components.json` has no effect.

```json
{
  "components": [
    { "name": "Core", "pathGlobs": ["src/core/*"], "description": "Domain logic" },
    { "name": "CI", "pathGlobs": [".github/workflows/*.yaml", "Dockerfile"] }
  ]
}
```

The key is an array, and each entry follows these rules:

- `name` is a string of 1 to 100 characters that is not blank. Repometry trims it, and two components cannot share a name.
- `pathGlobs` is a list of one or more paths relative to the repository root. A pattern has no leading `/`, no drive letter, no backslash, no empty segment and no `.` or `..` segment. Repeated patterns count once.
- `*` matches any run of characters, `/` included, so `src/core/*` holds every file below that folder. A pattern without `*` matches one exact path.
- `description` is an optional string.

A config that breaks a rule fails the command with an error. `--no-config` skips the key.

Components apply when `report` or `view` runs, so changing them needs no new analysis. On the Metrics page, group by Components to see a row for each component and a row for the files none holds. The query also takes a component as a filter. With no components defined, the page says so.

## Parsers

The `parsers` key of `repometry.config.json` chooses the plugin that parses a language when several plugins provide it. It maps a language ID to an ordered list of plugin IDs.

- A language that one plugin provides needs no entry.
- A language that several plugins provide needs an entry. Without one, the run stops with an error that names the plugins.
- Only the listed plugins are candidates. The first one that is available parses the language for the whole run.
- A later plugin parses the language only when the one before reports that its tool is missing. Only the packaged Go and Python parsers report this.
- A parser that fails on a file is not replaced by the next one.
- When no listed plugin is available, the files stay in scope, unparsed, and the report records the reason.
- The chosen plugin's definition of the language applies: its extensions, globs, label, colour, syntax and measures.

To keep the built-in JavaScript parser when `my-parser` also provides JavaScript and TypeScript, list `babel-syntax` for both languages:

```json
{ "parsers": { "javascript": ["babel-syntax"], "typescript": ["babel-syntax"] } }
```

To prefer the packaged Go parser and use `my-parser` when `go` is not installed, list both in that order:

```json
{ "parsers": { "go": ["go-ast", "my-parser"] } }
```

`repometry plugins` and the applied configuration in the report show each language under the one plugin that parses it. A plugin that parses none of its languages stays in the list with its availability, such as `go not found on PATH`, and without those languages.

The `inspect`, review and diff coverage requests of the library take the same optional `parsers` field. Their messages start with `parsers`, without the word `Config`.

| Message | Meaning |
| --- | --- |
| `Config parsers must map language IDs to lists of plugin IDs` | `parsers` is not an object. |
| `Config parsers/<language> must use a language ID` | The key is not a language ID: lowercase letters, digits and `-`, starting with a letter. |
| `Config parsers/<language> must be a nonempty list of unique plugin IDs` | The value is not a list, is empty, repeats an ID, or holds something other than a string. |
| `Config parsers/<language> names an unknown language` | No plugin provides this language. |
| `Config parsers/<language>/<n> names unknown plugin <id>` | The list holds an ID that is not a plugin. `<n>` counts from 0. |
| `Config parsers/<language>/<n> names plugin <id>, which does not provide <language>` | The plugin exists but does not provide the language. |
| `Config parsers/<language> is required to choose among <a>, <b>` | Several plugins provide the language and `parsers` has no entry for it. |
| `Multiple language providers claim <path>: <a>, <b>` | Two chosen parsers claim one file under different languages. Narrow the extensions or globs of one plugin. |

## Exit codes

| Command | 0 | 2 | 3 | 130 | 1 |
| --- | --- | --- | --- | --- | --- |
| `analyze` | The inspection is complete. | The inspection is partial, or a range had a failed or partial commit. | | A range was interrupted. | The command could not run. |
| `review` | The check passed. | A measurement it needs is missing on the head. | The check failed. | | The command could not run. |
| `store check` | No problems found. | | Problems found. | | The command could not run. |
| `show`, `history`, `report`, `view`, `projects`, `plugins`, `cache` | The command succeeded. | | | | The command failed or could not run. |

Bad usage, such as an unknown option or a missing argument, exits with 1 on every command. `view` runs until you stop it, and it exits with 130 when you stop it with Ctrl-C.

## Environment variables

| Variable | Effect |
| --- | --- |
| `REPOMETRY_CACHE_DIR` | Replaces the system cache folder that `repometry cache path` prints. |
| `REPOMETRY_DEBUG` | With `1`, the errors for a folder that is not a Git repository and a revision that is not a commit add Git's own message. |
