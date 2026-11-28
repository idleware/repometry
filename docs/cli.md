# Commands and configuration

This page covers the options that every command shares, the configuration file, the `plugins` and `projects` commands, exit codes and the environment variables that the [README](../README.md#usage) leaves out. [Reading inspections](store.md#reading-inspections) describes `history` and `show`. [Write a plugin](plugins.md) describes how to write a plugin, and [Docker plugins](process-plugins.md) describes plugins that run in a container.

## Packages

| Package | Command | Languages | Install size |
| --- | --- | --- | --- |
| `@repometry/cli` | `repometry-cli` | JavaScript, TypeScript | about 8 MB |
| `repometry` | `repometry` | The above, Go, Python, Java, PHP | about 15 MB |
| `@repometry/all` | `repometry-all` | The above, Ruby, Kotlin, HCL, Lua, Scala, Elixir, Rust | about 28 MB |

`repometry` and `@repometry/all` are `@repometry/cli` with language plugins already built in, so those languages need no `plugins` entry. To add a language to `@repometry/cli`, install its plugin package next to it and reference it:

```sh
npm install --save-dev @repometry/cli @repometry/language-ruby
```

```json
{ "plugins": ["@repometry/language-ruby"] }
```

Then run `npx repometry-cli analyze`. A plugin that is listed but not installed is an error; Repometry never downloads or installs one. See [Plugins](#plugins) and [Languages](native-languages.md).

## Analysis options

- `analyze` with no revision analyses `HEAD`. Use `analyze REVISION` to analyse another commit, or `--working-tree` for the working directory.
- `--branch NAME` on `report` and `view`, or `branch` in `repometry.config.json`, only names the branch the report shows. It never selects a commit.
- An option given on the command line replaces the same key in `repometry.config.json`; the config's value is not merged with it. This holds for `--import` and `imports`, `--exclude` and `exclude`, `--branch` and `branch`, `--source` and `source`, and for the formats typed after `report` and `reports`. `--no-config` skips the config file.
- `analyze BASE..HEAD` rejects `--import`, because an import describes one checkout. It skips the config's `imports` and says so on stderr.
- A path typed on the command line resolves against the folder the command runs in, or against `--repo DIR` (`-C DIR`) on a command that takes it. This covers `--import`, `--store`, `--config` and the path in `report FORMAT=PATH`. A path in `repometry.config.json` resolves against the repository root, wherever the command runs. This covers the paths in `imports` and `reports`. A plugin reference that starts with `./` or `../` resolves against the folder of the config file; see [Plugins](#plugins).
- A command takes `--repo` and `--store` only when it uses them. `analyze`, `show`, `history`, `report` and `store check` take both. `review` and `plugins` take `--repo`. `view` takes `--store`, and its `TARGET` says where to look. `projects` and `cache` take neither. Any other command rejects the option as unknown.
- `--config FILE` reads another configuration file, and `--no-config` skips the configuration. `analyze`, `review`, `report`, `view` and `plugins` take both. Giving both is an error. Without either option, a command reads `repometry.config.json` in the repository root, and a missing file is not an error.

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

## Configuration

`repometry.config.json` holds the options that every run of a repository shares. The file is a JSON object. Repometry rejects a key that is not in this table, and every error names the file and the path of the fault.

```json
{
  "$schema": "./node_modules/repometry/target/main/resources/report/json/config-v2.schema.json",
  "exclude": ["vendor/**"],
  "source": "github",
  "plugins": [
    "secrets",
    { "use": "./tools/long-lines.js", "options": { "maxLength": 100 }, "exclude": ["docs/**"] }
  ],
  "parsers": { "go": ["language-go"] },
  "components": [{ "name": "CLI", "include": ["src/cli/*"] }],
  "ignore": [
    { "category": "security", "path": ["**/test/**", "fixtures/**"], "reason": "Fixtures are insecure on purpose." }
  ],
  "imports": ["lcov=coverage/lcov.info"],
  "reports": ["html=public"],
  "branch": "main",
  "minCoverage": 80,
  "minLines": 20,
  "maxNewIssues": 0
}
```

| Key | Value | Meaning |
| --- | --- | --- |
| `$schema` | string | A hint for editors: the path or URL of the [configuration schema](../packages/cli/src/main/resources/report/json/config-v2.schema.json), whose ID is `urn:repometry:schema:config:2`. Repometry ignores the value. |
| `exclude` | list of globs | Files that no inspection contains. See [Scope](#scope). |
| `ignore` | list of rules | Findings, and coverage of files, that an inspection does not count. See [Ignore rules](#ignore-rules). |
| `imports` | list of `FORMAT=PATH` | Coverage and scanner reports to import. `--import` replaces it. See [Analysis options](#analysis-options). |
| `reports` | list of `FORMAT[=PATH]` | The formats that `report` writes when you give none. |
| `branch` | string | The branch name that a report shows. |
| `components` | list of components | Groups of files that the report totals. See [Components](#components). |
| `minCoverage` | number from 0 to 100 | The lowest coverage of changed lines that `review` accepts. |
| `minLines` | non-negative integer | The fewest measured changed lines from which `review` applies `minCoverage`. |
| `maxNewIssues` | non-negative integer | The most new issues that `review` accepts. [CI](ci.md#pull-requests) describes the review. |
| `plugins` | list of references | The plugins to add or to configure. See [Plugins](#plugins). |
| `parsers` | map of language ID to list of plugin IDs | Which plugin parses a language. See [Parsers](#parsers). |
| `source` | string | Where the report reads source files. See [Source](#source). |

## Plugins

`plugins` lists the plugins that take part in an inspection besides the built-in ones. The config never describes a plugin. It references one and passes options. The plugin describes itself in its own manifest; [Write a plugin](plugins.md#the-manifest) lists the fields.

An entry is a string, or an object with these keys:

| Key | Required | Meaning |
| --- | --- | --- |
| `use` | yes | The reference. |
| `options` | no | JSON data that the plugin's `optionsSchema` accepts. A plugin without an `optionsSchema` accepts no options. |
| `include` | no | Globs that replace the plugin's own file selection. `include: []` selects no file. |
| `exclude` | no | Globs that replace the plugin's own exclusions. `exclude: []` removes no file for this plugin. |

A string is the same as an object with only `use`. An entry accepts no other key.

```json
{
  "plugins": [
    "@acme/repometry-eslint",
    "@repometry/language-kotlin",
    "docker:ghcr.io/acme/parser@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    { "use": "./tools/my-checks.js", "options": { "limit": 10 }, "exclude": ["legacy/**"] },
    { "use": "./tools/parser.json" },
    { "use": "secrets", "exclude": ["fixtures/**"] }
  ]
}
```

### References

Repometry reads `use` with the first row of this table that fits.

| Form | Selects |
| --- | --- |
| `docker:<image>` | A Docker image that the local Docker daemon already has. Repometry never pulls it. The image describes itself with its `repometry.plugin` label. |
| Starts with `./`, `../` or `/` | A local file, resolved against the folder of the config file. A `.js`, `.mjs` or `.cjs` file is a JavaScript module. A `.json` file is a [Docker manifest](process-plugins.md#the-manifest-file). Any other file is an error. |
| `npm:<package>` | An installed npm package. |
| A built-in plugin ID | That built-in plugin. |
| Anything else | An installed npm package, such as `@repometry/language-kotlin`, the [Kotlin plugin](native-languages.md#add-a-language-to-a-smaller-package). |

A package resolves from Repometry's own installation only, including an installation that `npm exec` assembles. Repometry downloads nothing during a run. Install a package next to Repometry, or use `npm:` to choose a package whose name is also a built-in plugin ID.

The rest of the config names a plugin by its `id`, as `repometry plugins` prints it: `parsers`, `ignore[].plugin` and `source` take an ID, not a reference.

Each plugin ID is unique. A plugin that uses the ID of a built-in plugin or of an earlier entry is an error. List a built-in plugin once, to give it a scope. The listing does not add the plugin twice. No built-in plugin accepts options.

A plugin of the `language` category provides languages. Several plugins can provide one language; see [Parsers](#parsers).

An inspection saves each plugin's options with the inspection, so keep secrets out of `options`. A JavaScript plugin runs with the rights of the user who runs Repometry; [Write a plugin](plugins.md#trust) describes the trust this needs.

`report` and `view` read the config for `components`, `source`, `reports` and `branch`. They do not load plugins.

## Scope

The top-level `exclude` is the boundary of every inspection. A file that it removes is in no inspection, whatever a plugin selects. `--exclude` replaces it for one run. Repometry also leaves out the files that [Technical debt](metrics.md#debt-ratio-and-grades) lists.

On a plugin entry, `include` replaces the plugin's own file selection, and `exclude` replaces the plugin's own exclusions. Both work among the files that the inspection contains. A plugin cannot select a file that the top-level `exclude` removes. A plugin with no `include` of its own and no entry `include` works on every file that it can read.

A language plugin lists the globs of each language under `languages`. If several languages share a parser, the language globs decide the language of each file. An entry `include` on a language plugin replaces the plugin's file selection. If the plugin provides one language, that language applies to every file that the entry selects.

Globs in `exclude`, `ignore[].path` and a plugin's `include` and `exclude` follow these rules:

- A glob is relative to the repository root and uses `/` as the separator. It has no leading `/`, no drive letter, no backslash, no empty segment and no `.` or `..` segment. A leading `./` is removed.
- `*` matches any run of characters inside one path segment. `**` matches any number of segments. `{a,b}` matches either alternative.
- A glob that matches a folder matches everything below it.

`components[].include` is different: its `*` also matches `/`. See [Components](#components).

## Ignore rules

An `ignore` rule keeps findings out of the counts, or keeps files out of the coverage totals. A rule applies where every key it gives matches.

```json
{
  "ignore": [
    { "category": "security", "path": ["**/test/**", "fixtures/**"], "reason": "Fixtures are insecure on purpose." },
    { "plugin": "js-security", "check": "weak-hash", "path": "tools/**", "reason": "Git object IDs are SHA-1." },
    { "category": "coverage", "path": "generated/**", "reason": "Generated code has no tests." }
  ]
}
```

| Key | Required | Matches |
| --- | --- | --- |
| `category` | no | The category of the plugin that produces the finding: `maintainability`, `security` or `coverage`. |
| `plugin` | no | The ID of the plugin that reports the finding. For a finding that an import brings in, it is the name of the scanner that wrote the report. |
| `check` | no | The ID of a check. Without `plugin`, it matches the check in any plugin. |
| `path` | no | The path of the file with the finding. One glob, or a nonempty list of globs where any glob can match. |
| `reason` | yes | Why the rule exists. It is not a selector. Repometry saves it with the ignored findings. |

Give at least one of `category`, `plugin`, `check` and `path`. The first rule that matches a finding wins.

| Category | Findings it matches |
| --- | --- |
| `maintainability` | Findings of the saved categories `structure`, `duplication` and `lint`. |
| `security` | Findings of the saved categories `security`, `dependency`, `secret` and `infrastructure`. |
| `coverage` | No findings. See below. |

A rule that matches a finding removes it from the active findings, from the technical debt and from the issue gate of `review`. The finding stays in the report under `ignoredFindings`, with the zero-based index of the rule in the config's `ignore` list as `matchedRule`. The applied configuration keeps every rule, with its reason, as `findingIgnore`.

A `coverage` rule removes the matching files from both coverage totals, the repository coverage and the coverage of changed lines. The code inventory and every other result keep the files. Coverage has no findings, so the rule has these limits:

- `path` is required.
- `check` is an error.
- `plugin` is `lcov` or absent.

## Source

`source` in the config, and `--source` on `report`, choose where the exported report reads source files from. The value is one of:

| Value | Meaning |
| --- | --- |
| `auto` | Detect the host from the CI variables and the Git remotes. This is the default. |
| `none` | Show no source files. |
| `ID` or `ID:SPEC` | Use the built-in source plugin `ID`: `github`, `gitlab` or `local`. `SPEC` names the repository, as in `github:OWNER/REPO`. |

An unknown ID gives `Unknown source provider: <id>. Choose github, gitlab, local.`. A plugin that cannot find the repository gives `Cannot locate source files for <id>. Name the repository as <id>:OWNER/REPO.`.

## The plugins command

`repometry plugins` prints the effective plugins as JSON: the built-in plugins and the ones from the config. It reads each manifest and checks `requires`. It does not call a plugin's `create` function and does not run a container. For a `docker:` reference, and for a `.json` manifest whose image is a tag, it asks the Docker daemon for the image ID.

```sh
npx repometry plugins
npx repometry plugins --config ci/repometry.config.json
```

The output has the schema `urn:repometry:schema:plugin-list:2` and these keys:

| Key | Value |
| --- | --- |
| `schema` | The schema ID. |
| `plugins` | One object for each plugin, described below. |
| `importers` | The formats that `--import` takes. |
| `reporters` | The formats that `report` writes. |
| `ci` | The CI providers that `review --ci` takes. |
| `stores` | The store types. |

A plugin object has these keys. A key that has no value is absent.

| Key | Value |
| --- | --- |
| `id` | The plugin ID. |
| `version` | The version. |
| `versionSource` | Where the version comes from: `built-in`, `manifest`, `package.json` or `default`. |
| `category` | `language`, `source`, `maintainability`, `coverage` or `security`. |
| `use` | The reference that selected the plugin, as written in the config. For a built-in plugin, its ID. |
| `available` | `true` when the requirements are met. |
| `reason` | Why the plugin is unavailable. Present only when `available` is `false`. |
| `include`, `exclude` | The globs that select files for the plugin: those of the entry, else those of the manifest. |
| `languages` | For a language plugin, each language with `id`, `label`, `color`, `include` and `measures`. |
| `checks` | The checks that the plugin declares. |
| `optionsSchema` | The JSON Schema of the plugin's options. |
| `requires` | The requirements that the manifest declares. |

This is the entry for the plugin in [Write a plugin](plugins.md#example), referenced as in the example config:

```json
{
  "id": "long-lines",
  "version": "1.0.0",
  "category": "maintainability",
  "use": "./tools/long-lines.js",
  "versionSource": "manifest",
  "available": true,
  "include": ["**/*.md", "**/*.js"],
  "checks": [{ "id": "long-line", "description": "A line is longer than the limit." }],
  "optionsSchema": {
    "type": "object",
    "properties": { "maxLength": { "type": "integer", "minimum": 20 } },
    "additionalProperties": false
  },
  "exclude": ["tools/**"]
}
```

## Components

Components group files by path, so the report can total each group. Define them in the `components` key of `repometry.config.json`. Repometry reads no other file for them, so a `.repometry/components.json` has no effect.

```json
{
  "components": [
    { "name": "Core", "include": ["src/core/*"], "description": "Domain logic" },
    { "name": "CI", "include": [".github/workflows/*.yaml", "Dockerfile"] }
  ]
}
```

The key is an array, and each entry follows these rules:

- `name` is a string of 1 to 100 characters that is not blank. Repometry trims it, and two components cannot share a name.
- `include` is a list of one or more paths relative to the repository root. A pattern has no leading `/`, no drive letter, no backslash, no empty segment and no `.` or `..` segment. Repeated patterns count once.
- `*` matches any run of characters, `/` included, so `src/core/*` holds every file below that folder. A pattern without `*` matches one exact path.
- `description` is an optional string.

A config that breaks a rule fails the command with an error. `--no-config` skips the key.

Components apply when `report` or `view` runs, so changing them needs no new analysis. On the Metrics page, group by Components to see a row for each component and a row for the files none holds. The query also takes a component as a filter. With no components defined, the page says so.

## Parsers

The `parsers` key of `repometry.config.json` chooses the plugin that parses a language when several plugins provide it. It maps a language ID to an ordered list of plugin IDs.

- A language that one plugin provides needs no entry.
- A language that several plugins provide needs an entry. Without one, the run stops with an error that names the plugins.
- Only the listed plugins are candidates. The first one that is available parses the language for the whole run.
- A later plugin parses the language only when the one before is unavailable, because its `requires` are not met. The built-in parsers have no requirements and are always available.
- A parser that fails on a file is not replaced by the next one.
- When no listed plugin is available, the files stay in scope, unparsed, and the report records the reason.
- The chosen plugin's definition of the language applies: its `include` globs, label, colour, syntax and measures.

To keep the built-in JavaScript parser when `my-parser` also provides JavaScript and TypeScript, list `babel-syntax` for both languages:

```json
{ "parsers": { "javascript": ["babel-syntax"], "typescript": ["babel-syntax"] } }
```

To keep the built-in Go parser when `my-parser` also provides Go, list `language-go`:

```json
{ "parsers": { "go": ["language-go"] } }
```

To prefer `my-parser` and use the built-in parser when `my-parser` is unavailable, list both in that order:

```json
{ "parsers": { "go": ["my-parser", "language-go"] } }
```

`repometry plugins` and the applied configuration in the report show each language under the one plugin that parses it. A plugin that parses none of its languages stays in the list with its availability, and without those languages.

The `inspect`, review and diff coverage requests of the library take the same optional `parsers` field. Their messages start with `parsers`, without the word `Config`.

## Configuration errors

An error that comes from the config file starts with `repometry: <file>: `, where `<file>` is the path of the file. The tables below omit that start. `<n>` is a zero-based index. Without a config file, as in a library call, a message starts with `Config ` and has no file path.

### Keys and values

| Message | Cause and fix |
| --- | --- |
| `must be an object` | The file holds JSON that is not an object. |
| `/<key> is not a supported field` | The key is not one of the 13 keys. |
| `sources is renamed. Write source.` | The config uses `sources`. |
| `<key> must be a nonempty string` | `$schema`, `source` or `branch` is not a string, or is blank. |
| `<key> must be a string list` | `imports` or `reports` is not a list of nonempty strings. |
| `minCoverage must be a number from 0 to 100` | The value is out of range. |
| `<key> must be a non-negative integer` | `minLines` or `maxNewIssues` is not a whole number of 0 or more. |
| `Profile exclude must be an array of repository-relative paths or globs` | `exclude` is not a list. |
| `Profile exclude/<n> must be a string` or `Profile exclude/<n> must be a repository-relative path or glob. Received "<glob>".` | The glob breaks the [glob rules](#scope). |
| `Unknown source provider: <id>. Choose github, gitlab, local.` | `source` or `--source` names no built-in source plugin. |
| `Cannot locate source files for <id>. Name the repository as <id>:OWNER/REPO.` | The source plugin cannot find the repository. Give `ID:SPEC`. |
| `--sources is not an option of report. Did you mean --source?` | The command line uses `--sources`. |
| `Choose --config or --no-config` | The command line has both options. |

### Plugins

| Message | Cause and fix |
| --- | --- |
| `plugins must be an array` | `plugins` is not a list. |
| `plugins/<n> must be a nonempty plugin reference` | An entry is an empty string. |
| `plugins/<n> must be a reference string or an object with use, options, include and exclude` | An entry has no `use`, or has another key. |
| `plugins/<n>/use must be a nonempty plugin reference` | `use` is not a nonempty string. |
| `plugins/<n> describes a plugin inline. Move it into a manifest file and reference it with { "use": "./plugin.json" }.` | The entry has `id`, `image` or `command`. Write a [Docker manifest](process-plugins.md#the-manifest-file). |
| `plugins/<n>/options must be JSON data` | `options` holds a value that JSON cannot carry. |
| `plugins/<n>/options is not accepted by this plugin` | The plugin declares no `optionsSchema`. Remove `options`. |
| `plugins/<n>/options<path> <problem>` | The options break the plugin's `optionsSchema`, for example `plugins/0/options/maxLength must be >= 20` or `plugins/0/options/colour is not allowed`. |
| `plugins/<n>/include must be an array of repository-relative paths or globs`, `plugins/<n>/include/<m> must be a string`, or `plugins/<n>/include/<m> must be a repository-relative path or glob. Received "<glob>".` | The globs break the [glob rules](#scope). The same messages exist for `exclude`. |
| `plugins/<n> could not resolve npm package <name> from Repometry at <folder>` | The package is not installed next to Repometry. Install it there. |
| `plugins/<n> must name an installed npm package` | The reference is not a package name. |
| `plugins/<n> must reference a JavaScript module or a Docker manifest JSON file` | A path reference ends in neither `.js`, `.mjs`, `.cjs` nor `.json`. |
| `plugins/<n> could not load its JavaScript plugin: <reason>` | Node.js could not load the module. The reason is Node.js's. |
| `plugins/<n>/manifest could not read <path>` | The `.json` manifest is missing or is not JSON. |
| `plugins/<n> requires Docker on PATH to read its image manifest` | A `docker:` reference needs the `docker` command. |
| `plugins/<n> could not inspect local Docker image <image>` | The local Docker daemon has no such image. Repometry never pulls one. |
| `plugins/<n> is missing the repometry.plugin image label` | The image has no manifest. |
| `plugins/<n> has an invalid JSON repometry.plugin image label` | The label is not JSON. |
| `plugins/<n> plugin <id> from <use> duplicates <earlier>` | Two entries, or an entry and a built-in plugin (shown as `<id> (built-in)`), have one ID. |

[Write a plugin](plugins.md#errors) lists the errors for the fields of a manifest.

### Ignore rules and components

| Message | Cause and fix |
| --- | --- |
| `ignore must be an array` | `ignore` is not a list. |
| `ignore/<n> must be an object` | A rule is not an object. |
| `ignore/<n>/tool is renamed. Write plugin.` | A rule uses `tool`. |
| `ignore/<n>/rule is renamed. Write check.` | A rule uses `rule`. |
| `ignore/<n> accepts category, plugin, check, path and reason` | A rule has another key. |
| `ignore/<n>/reason is required` | The rule has no reason. |
| `ignore/<n> needs at least one of category, plugin, check or path` | The rule has only a reason. |
| `ignore/<n>/category must be maintainability, coverage or security` | Another category. |
| `ignore/<n>/plugin must name a plugin or the reporter named in an imported finding` | `plugin` is not a nonblank one-line string. |
| `ignore/<n>/check must name a check` | `check` is not a nonblank one-line string. |
| `ignore/<n>/reason must give a reason` | `reason` is not a nonblank one-line string. |
| `ignore/<n>/path must be a glob or a nonempty list of globs` | `path` is empty, or holds something other than strings. |
| `ignore/<n>/path must use repository-relative globs` | A glob breaks the [glob rules](#scope). |
| `ignore/<n>/path is required for coverage to identify the files to exclude` | A `coverage` rule has no `path`. |
| `ignore/<n>/check is unavailable for coverage because coverage has no findings` | A `coverage` rule has `check`. |
| `ignore/<n>/plugin must be lcov for coverage` | A `coverage` rule names another plugin. |
| `components must be an array` | `components` is not a list. |
| `components/<n> must be an object` | An entry is not an object. |
| `components/<n>/pathGlobs is renamed. Write include.` | An entry uses `pathGlobs`. |
| `components/<n>/<key> is not a supported field` | An entry has a key other than `name`, `include` and `description`. |
| `components/<n>/name must be between 1 and 100 characters` | The name is blank or too long. |
| `components/<n>/name duplicates <name>` | Two components share a name. |
| `components/<n>/include must specify repository-relative include globs` | `include` is empty, or a pattern breaks the rules above. |
| `components/<n>/description must be a string` | The description is not a string. |

### Parsers

| Message | Cause and fix |
| --- | --- |
| `parsers must map language IDs to lists of plugin IDs` | `parsers` is not an object. |
| `parsers/<language> must use a language ID` | The key is not a language ID: lowercase letters, digits and `-`, starting with a letter. |
| `parsers/<language> must be a nonempty list of unique plugin IDs` | The value is not a list, is empty, repeats an ID, or holds something other than a string. |
| `parsers/<language> names an unknown language` | No plugin provides this language. |
| `parsers/<language>/<n> names unknown plugin <id>; <language> is provided by <a>, <b>` | The list holds an ID that is not a plugin. The text after `;` names the plugins that provide the language, such as `parsers/go/0 names unknown plugin go-ast; go is provided by language-go`. |
| `parsers/<language>/<n> names plugin <id>, which does not provide <language>; <language> is provided by <a>, <b>` | The plugin exists but does not provide the language. The text after `;` names the plugins that do. |
| `parsers/<language> is required to choose among <a>, <b>` | Several plugins provide the language and `parsers` has no entry for it. |
| `Parsers <a> and <b> both include <path>` | Two chosen parsers select one file under different languages. Narrow the `include` globs of one plugin. |

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

## Projects index

`repometry projects DIR` builds an index page for a folder of exported reports and writes it into `DIR`. Without `DIR` it uses the current folder. Each subfolder that holds an `index.html` and a valid `summary.json`, as `repometry report html=DIR/NAME` writes them, becomes an entry.

```sh
repometry report html=sites/app --store .repometry
repometry projects sites
```
