# Write a plugin

A plugin adds files, measurements, findings or languages to an analysis. This page is for plugin authors. It describes the manifest to write, what Repometry supplies, what it runs, and the errors it reports.

## What a plugin is

A plugin is a manifest: a JSON-like description with an `id`, a `category`, and optional metadata. A JavaScript plugin adds a `create` function that returns the operations. Each operation reads named inputs and returns one value. Repometry plans the operations, runs them, and saves what they return in the report.

There are two forms of plugin, and both use the same manifest schema:

| Kind | Where it lives | Reference in the config |
| --- | --- | --- |
| JavaScript plugin | A module whose default export is the manifest. A local file, or an installed npm package. | `./tools/my-checks.js` or `my-package` |
| Docker plugin | A Docker image that carries the manifest in a label, or a `.json` manifest file that names the image. | `docker:IMAGE` or `./plugin.json` |

[Plugins](cli.md#plugins) in the configuration describes the references. [Docker plugins](process-plugins.md) describes the second kind. You can also pass manifests and references in the `plugins` field of `inspect`, `review` and `measureDiffCoverage` from `repometry`. A relative reference then resolves against the repository root.

`measureDiffCoverage` accepts `plugins` only to decide which files are source files. It runs built-in operations only, so pass the same language plugins to `inspect` and `measureDiffCoverage` to select the same paths.

The report saves some fields under names that older stores also use. A saved finding has the fields `tool` for the plugin and `rule` for the check, and the applied configuration of a saved report lists a plugin's `api`, `kinds`, `claims`, `settings` and `providesLanguages`. These names stay as they are so that old stores stay readable. This page uses the manifest names.

## The manifest

A JavaScript plugin exports a manifest as the default export of its module. Import the types and the contracts from `repometry/plugin`.

```js
import { findingResult, pluginManifestSchema, sourceFile } from 'repometry/plugin';

export default {
  schema: pluginManifestSchema,
  id: 'my-checks',
  category: 'maintainability',
  include: ['**/*.js'],
  optionsSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' } } },
  requires: { node: '>=24', tools: ['git'] },
  checks: [{ id: 'my-check', description: 'What the check reports.' }],
  create(options, context) {
    return { operations: [/* ... */], produces: [{ contract: findingResult.id, persistence: 'report' }] };
  },
};
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | Exactly `urn:repometry:schema:plugin:1`. `pluginManifestSchema` holds the value. |
| `id` | yes | The plugin ID: a lowercase letter, then lowercase letters, digits and `-`. It is unique among the loaded plugins. A built-in plugin's ID is an error. |
| `category` | yes | The one role of the plugin. See [Categories](#categories). |
| `version` | Docker plugins | The plugin's version. See [Version](#version). |
| `include`, `exclude` | no | Globs that select the files the plugin works on. A user can replace them for one config entry. |
| `languages` | `language` plugins only | The languages the plugin provides. See [Languages](#languages). |
| `optionsSchema` | no | The JSON Schema of the plugin's options. Without it, the plugin accepts no options. |
| `requires` | no | What the plugin needs to run. See [Requirements](#requirements). |
| `checks` | no | The checks the plugin reports. See [Checks](#checks). |
| `create(options, context)` | JavaScript plugins | Returns the operations. See [The create function](#the-create-function). |
| `image`, `command`, `scope`, `fileIndependent`, `limits`, `tools` | Docker plugins only | See [Docker plugins](process-plugins.md#the-manifest-file). A JavaScript plugin that has one of them is an error. |

A manifest has no other field. Repometry checks the declarative part of every manifest against the [plugin manifest schema](../packages/core/src/main/resources/plugin-v1.schema.json). The schema file is published as `@repometry/core/plugin-v1.schema.json`, and its `$id` is `urn:repometry:schema:plugin:1`. For a JavaScript plugin, the `create` function is the part that the schema leaves out.

### Categories

A plugin has one category. Repometry reads the category from the manifest, and the config names no category.

| Category | Role | What the plugin returns |
| --- | --- | --- |
| `language` | Parses files of the languages it provides. | A code structure for each file. |
| `maintainability` | Reports quality findings and measurements. | Findings and measurements. |
| `security` | Reports security findings. It counts as a security scanner, and the report marks its metrics private. | Findings and measurements. |
| `coverage` | Measures coverage. | Measurements. A finding is an error: `Plugins in coverage do not produce findings`. |
| `source` | Locates the source files for a report. | Built-in plugins only. `source` and `--source` select one; see [Source](cli.md#source). |

[Ignore rules](cli.md#ignore-rules) select findings by the category of the plugin that reports them.

### Options

`optionsSchema` is a JSON Schema, or a boolean. The config entry's `options` must match it. Repometry validates the options before it calls `create`, with JSON Schema draft 2020-12.

- A plugin with no `optionsSchema` accepts no options. An entry with `options` is an error.
- A plugin with an `optionsSchema` gets `{}` when the entry has no `options`. Repometry applies no defaults, so `create` supplies its own.
- `optionsSchema: false` accepts no options, and `true` accepts any JSON value.
- Options are JSON data. A value that JSON cannot carry is an error.
- `create` receives a copy of the options.

An invalid option gives an error that names the option, such as `plugins/0/options/maxLength must be >= 20`. Repometry saves the options with the inspection and records them in the applied configuration, so keep secrets out of them. Pass a secret through an environment variable that the plugin reads, or through a file whose path is an option.

### Requirements

`requires` declares what the plugin needs. Each key is optional.

| Key | Value | Met when |
| --- | --- | --- |
| `node` | A semver range, such as `>=24`. | The running Node.js version is in the range. |
| `repometry` | A semver range, such as `>=0.13`. | The running Repometry version is in the range. |
| `tools` | A list of executable names, such as `["eslint"]`. | Each name is an executable file in a folder on `PATH`. A name has no path separator. |

Repometry checks the requirements before it calls `create`. A plugin whose requirements are not met is unavailable:

- Repometry does not call `create` and runs none of its operations. The rest of the inspection goes on.
- `repometry plugins` prints `"available": false` and a `reason`, such as `required executable eslint is not on PATH`.
- The applied configuration of the report records the plugin and the reason.
- If the plugin is a language plugin, [parsers](cli.md#parsers) can fall back to the next plugin in the list.

A Docker plugin always requires the `docker` command, in addition to what it declares.

### Version

A plugin's version is saved in the report and starts a new profile when it changes.

| Plugin | The version comes from |
| --- | --- |
| An installed npm package | The `version` in the package's `package.json`. The manifest's `version` is not used. |
| A local JavaScript file | The manifest's `version`. Without it, `0.0.0`. |
| A Docker image or a `.json` manifest | The manifest's `version`. It is required. |
| A built-in plugin | Repometry. |

`repometry plugins` prints the version and, as `versionSource`, where it comes from.

## The create function

`create(options, context)` returns `{ operations, produces }`, or a promise of that object. It runs once for each run that uses the plugin.

- `options` is the validated options of the config entry, or `undefined` when the plugin has no `optionsSchema`.
- `context.root` is the absolute path of the repository root, or of the directory of a working-tree analysis.
- It runs in `analyze`, `review` and the library requests. `repometry plugins`, `report` and `view` do not call it.
- An error that it throws stops the run, and the message names the config file.
- It must return an object with exactly the keys `operations` and `produces`, and each operation must have an `execute` function. Otherwise the error is `plugins/<n>/manifest/create must return executable operations and declared products`.

### Operations

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Not empty, no `/`, unique in the plugin. The full key is `<plugin>/<operation>`. |
| `role` | `'provider'` or `'inspection'` | yes | An inspection reads files and returns results for the report. A provider returns data for other operations. A language provider's parse operation is a provider. |
| `scope` | `'file'` or `'repository'` | no | Default `file`. A file operation runs once for each file. A repository operation runs once for all the files the plugin selects. |
| `fileIndependent` | boolean | no | For a repository provider that returns the same results for a file whatever other files it receives. |
| `inputs` | object | yes | Port name to contract. Port names are yours. Repometry matches by contract ID. |
| `output` | contract | yes | What `execute` returns. It must be declared in `produces`. |
| `implementation` | string | no | A fingerprint for details that the version and the inputs do not carry. |
| `execute(inputs)` | function | yes | Returns the value or a promise of it. |

A contract is `{ id, accepts }`, where `accepts` is a type guard. Repometry checks every input and the output with it.

`execute` receives:

- `inputs.read(port, contract)` returns the input on that port. The contract must be the one declared for the port, or the call throws `Undeclared input contract`.
- `inputs.emitDiagnostic?.(message, path?)` records a warning. The results stay valid, and the inspection becomes partial. `path` defaults to the file the operation runs on. A repository operation has no default. Call it with `?.`, because the type marks it optional.

A thrown error or a rejected promise fails the operation. The report records it as a diagnostic, and the analysis goes on. Operations that read its output are blocked.

### Products

`produces` declares every contract that an operation outputs.

| Field | Meaning |
| --- | --- |
| `contract` | The contract ID. |
| `persistence` | `report` saves the value in the report. `transient` passes it to other operations only. `cache` keeps it out of the report, and the CLI keeps no operation cache. |
| `valueSchema` | A JSON Schema, or a boolean, that the value must match. |
| `metrics` | The metrics that the rows of this product use. |

A `report` product needs a `valueSchema`, except for the rows contracts, `measurements` and `findingResult`, or a product that declares `metrics`. A `transient` product needs none. A `report` product with a schema must be JSON data.

A measurement row must use a metric that the product declares. A metric has these fields:

| Field | Meaning |
| --- | --- |
| `id`, `label` | Required. The ID is unique across all plugins. |
| `unit` | Required. `count`, `ratio` or `minutes`. |
| `scope` | Required. `repository`, `file` or `function`. |
| `aggregate` | Required. `sum`, `max` or `none`. |
| `better` | Required. `lower`, `higher` or `none`. |
| `ratio` | `{ of, over }`, the metric IDs of the numerator and denominator. Only for `unit: 'ratio'`. |
| `short`, `description`, `group`, `bands` | Optional. `bands` is four increasing numbers. |

## Checks

A check is one named finding type that the plugin reports. Declare each one in `checks`, so that `repometry plugins` lists it without running the plugin.

| Field | Meaning |
| --- | --- |
| `id` | Required. Unique in the plugin. |
| `description` | Optional text. |
| `defaults` | Optional `{ limit, cost }`, numbers of 0 or more. A check with a `cost` charges effort. |
| `measure` | Optional. A metric ID the plugin declares. An unknown ID is an error. |
| `per` | Optional pair of words: the unit in singular and plural. |

A finding in the result of `findingResult` has these fields:

| Field | Meaning |
| --- | --- |
| `check` | Required. The ID of the check. |
| `plugin` | Optional. If present, it is the plugin's own ID. Repometry fills it in. |
| `level` | Required. `low`, `medium`, `high` or `unknown`. |
| `message` | Required. |
| `path`, `line`, `endLine` | Optional location. `line` needs `path`, and `endLine` needs `line`. |
| `effortMinutes` | Optional. The minutes to fix the issue. |
| `value`, `limit` | Optional. The value the check judged and the value it allows. |
| `anchor` | Optional. What the issue is about across commits, such as a function's name. |
| `related` | Optional. Other locations, each with `path`, `line` and `endLine`. |

A security plugin's findings are security findings. For another plugin, a finding with `effortMinutes` counts as a structure finding and a finding without it counts as a lint finding. [Technical debt](metrics.md#technical-debt) describes how effort counts. A finding that names another plugin fails the operation with `A finding may only name its reporting plugin <id>`.

Structural observations in a code structure name their check in `check`.

## Languages

A language plugin turns files into a code structure. It has the category `language`, lists `languages`, and has exactly one provider operation. The operation reads `sourceFile` and outputs `codeStructure`, or has `scope: 'repository'`, reads `sourceFiles` and outputs `codeStructures`. [Language provider metrics](metrics.md) describes the fields of a structure.

Each entry in `languages` has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Required. Lowercase letters, digits and `-`, starting with a letter. Unique within the plugin. Another plugin may provide the same language. |
| `label` | Required. The display name. |
| `include` | Required. Globs that select the files of the language. |
| `color` | Optional, six hexadecimal digits with `#`. |
| `measures` | Optional. A subset of `functions`, `cyclomaticComplexity`, `cognitiveComplexity`, `classes`, `commentLines`, `codeLines`, `duplication`, `checks`. `duplication` needs `codeLines`. Repometry removes the other optional fields from the structures of this language before any operation reads them. |
| `syntax` | Optional data for the report viewer: `lineComments`, `blockComments`, `strings`, `stringPrefixes`, `keywords`, `regexAfter`. The [syntax table](process-plugins.md#syntax) gives the meaning of each. |

One provider handles each file. Two chosen providers that select one file under different languages are an error. Several plugins may provide one language, for example `go`. The user's `parsers` key chooses which of them parses it, so a plugin does not need to avoid IDs that other plugins use; [Parsers](cli.md#parsers) describes the rule. The report stores the language catalog once and records the provider operation for each source path. It also lists each distinct operation binding that ran in its applied configuration (`operations`): the key, the binding of each input, `implementation` and, for a repository operation, `scope`.

## Host contracts

The host supplies these contracts. An operation reads them as inputs.

| Contract | ID | Exported from `repometry/plugin` | Supplied |
| --- | --- | --- | --- |
| `sourceFile` | `repometry.source-file/v1` | yes | For each file the plugin selects. A file with `path` and `bytes`. In a working-tree run, the files are the tracked files and the untracked files that Git does not ignore. |
| `codeStructure` | `repometry.code-structure/v1` | yes | For each file that a language provider parsed, together with `sourceFile`. |
| `sourceFiles` | `repometry.source-files/v1` | yes | Once, to repository operations, with the files the plugin selects. The same files as for `sourceFile`. |
| `cloneSources` | `repometry.clone-sources/v1` | no | Once, after the files. |
| `lcovInput` | `repometry.lcov-input/v1` | no | Once, after the files, and only when coverage is imported. |
| `changesInput` | `repometry.git-line-changes/v1` | no | Only in a diff coverage run. Only built-in operations run there. |

The module also exports `measurements` and `findingResult` for outputs, `codeStructures` for repository providers, and the types of all of them. A plugin cannot import the contracts that are not exported, so it cannot read them. `changesInput` is never available to a plugin.

The files an operation sees are the files its plugin selects: the files that remain after the top-level `exclude` of the config, narrowed by the plugin's `include` and `exclude`. The `include` and `exclude` of a config entry replace those of the manifest. [Scope](cli.md#scope) describes the rules.

## How Repometry decides what runs

An analysis has three steps: the files, one at a time; the repository; and the run after the files. Each step supplies the host contracts of the table above that fit it.

1. An input is satisfied in a step by a host contract the step supplies, or by the output of another operation that runs in the same step. A product reaches only the operations of its own step.
2. An operation runs in the first step where all its inputs are satisfied.
3. The scope must fit the step. A file operation runs in the file step, and a repository operation in the repository step. An operation that reads only what the after-files step supplies runs once, whatever its scope.
4. An operation is left out, without an error, only when this run lacks a host input that it reads. The case is coverage that was not imported. An operation that reads the output of such an operation is left out too.
5. Every other operation that no step satisfies is an error. This includes inputs that no plugin outputs, inputs that no single step offers together, and cycles.
6. When two candidates could satisfy one input, the input is ambiguous. This is an error.

A reader of the code structure is an operation that reads `codeStructure`, directly or through the products of other operations. It runs only on files that have a language provider, limited to the files its plugin selects. A plugin with no `include` selects all parsed files. A reader that selects only Markdown runs on no file, and that is not an error. If the provider fails on a file, the reader is blocked there, and the report records `Unavailable inputs`.

Only a language provider supplies a file's code structure. Any other operation that outputs `codeStructure` or `codeStructures` is an error. A plugin that needs its own facts declares its own contract.

An operation that reads the product of another plugin runs on a file only when both plugins select that file. When the reader's plugin selects a file that the producer's plugin does not, the analysis stops with `Missing input <key>.<port> (<contract>)`. A file that only the producer selects does not run the reader.

An operation that does not read the code structure runs only on text files of at most 1 MiB. A larger file gets the diagnostic `Plugin inspection skipped a file larger than 1 MiB`.

## Trust

A JavaScript plugin is code that Repometry imports into its own process. It runs with the rights of the user who runs Repometry: it can read files, use the network and start programs. Reference only code that you trust.

- `repometry plugins`, `analyze` and `review` import the module. Its top-level code runs even when the plugin is unavailable.
- An npm package resolves from Repometry's own installation, and Repometry never installs one. Whoever installs the package decides what runs.
- A Docker plugin runs in a sandbox with no network and a read-only snapshot. [Docker plugins](process-plugins.md#limits-and-the-sandbox) describes it.
- Options are saved with every inspection and are visible to anyone who can read the store. Put no secret in `options`.

## Example

This plugin reports each line that is longer than a limit. It is a file plugin: its operation runs once for each file it selects. It declares one option, `maxLength`, and one check, `long-line`.

Add the project files `tools/long-lines.js` and `repometry.config.json`. Install `repometry` in the project, so that the import in the plugin resolves.

```js
import { findingResult, pluginManifestSchema, sourceFile } from 'repometry/plugin';

/** @type {import('repometry/plugin').PluginManifest<{ maxLength?: number }>} */
export default {
  schema: pluginManifestSchema,
  id: 'long-lines',
  category: 'maintainability',
  version: '1.0.0',
  include: ['**/*.md', '**/*.js'],
  optionsSchema: {
    type: 'object',
    properties: { maxLength: { type: 'integer', minimum: 20 } },
    additionalProperties: false,
  },
  checks: [{ id: 'long-line', description: 'A line is longer than the limit.' }],
  create(options) {
    const limit = options?.maxLength ?? 80;
    return {
      operations: [{
        id: 'scan',
        role: 'inspection',
        inputs: { source: sourceFile },
        output: findingResult,
        execute(inputs) {
          const { path, bytes } = inputs.read('source', sourceFile);
          const findings = new TextDecoder().decode(bytes).split('\n').flatMap((text, index) =>
            text.length > limit ? [{
              check: 'long-line',
              level: /** @type {const} */ ('low'),
              message: `The line has ${text.length} characters. The limit is ${limit}.`,
              path,
              line: index + 1,
              value: text.length,
              limit,
            }] : []);
          return { measurements: [], findings };
        },
      }],
      produces: [{ contract: findingResult.id, persistence: 'report' }],
    };
  },
};
```

```json
{
  "plugins": [
    { "use": "./tools/long-lines.js", "options": { "maxLength": 60 }, "exclude": ["tools/**"] }
  ]
}
```

The `JSDoc` type makes TypeScript check the manifest. Run the checker on the file:

```sh
npx tsc --noEmit --allowJs --checkJs --strict --module nodenext --target es2023 tools/long-lines.js
```

Run the analysis on a working tree. The command prints the digest of the inspection as `subject.id`, and `show` prints the saved report:

```sh
npx repometry plugins
npx repometry analyze --working-tree
npx repometry show DIGEST
```

For a `src/app.js` whose second line has 93 characters, the `findings` list of the report holds one finding:

```json
[
  {
    "level": "low",
    "message": "The line has 93 characters. The limit is 60.",
    "path": "src/app.js",
    "line": 2,
    "value": 93,
    "limit": 60,
    "tool": "long-lines",
    "rule": "long-line",
    "category": "lint"
  }
]
```

The finding has no `effortMinutes`, so it counts as a `lint` finding. The fields `tool` and `rule` are the saved names of the plugin and the check. The entry `exclude` keeps the plugin's own file out of the scan. An option that breaks the schema stops the run before any file is read: `"maxLength": 5` gives `plugins/0/options/maxLength must be >= 20`.

## Errors

Repometry rejects an invalid plugin before the analysis starts. `<key>` stands for `<plugin>/<operation>`, and `<n>` is the zero-based index of the entry in `plugins`. An error that comes from the config file starts with `repometry: <file>: `; the tables omit that start. [Plugins](cli.md#plugins) lists the errors for references and options.

### Manifest

| Message | Meaning and fix |
| --- | --- |
| `plugins/<n>/manifest/<field> is retired. Write <new field>.` | The manifest uses a field of the earlier authoring format. The message names the replacement: `api` to `schema`, `kinds` to `category`, `claims` to `include`, `settings` to `options`, `rules` to `checks`, `config` to `optionsSchema`, `providesLanguages` to `languages`. |
| `plugins/<n>/manifest/schema must be urn:repometry:schema:plugin:1` | `schema` is missing or has another value. |
| `plugins/<n>/manifest/category must be one of language, source, maintainability, coverage, security` | `category` is missing or unknown. |
| `plugins/<n>/manifest/<field> is required` | A required field is missing, such as `languages` for a `language` plugin or `include` in a language. |
| `plugins/<n>/manifest/<field> is not allowed` | The manifest has a field that the schema does not know. |
| `plugins/<n>/manifest/languages boolean schema is false` | A plugin that is not a `language` plugin lists `languages`. |
| `plugins/<n>/manifest/languages/<m>/measures/<k> must be one of "functions", ..., "checks"` | A language's `measures` holds an unknown value. |
| `plugins/<n>/manifest/<field> must match pattern "<pattern>"` | The value breaks the schema, such as an `id` with capital letters or a blank `version`. |
| `plugins/<n>/manifest/<languages or checks>/<m>/id duplicates <id>` | Two entries have one ID. |
| `plugins/<n>/manifest/create must create the plugin operations` | The module's default export has no `create` function. |
| `plugins/<n>/manifest/create must return executable operations and declared products` | `create` returned something other than `{ operations, produces }`. |
| `plugins/<n>/manifest/<field> belongs in a Docker manifest` | A JavaScript plugin has `image`, `command`, `scope`, `fileIndependent`, `limits` or `tools`. |
| `plugins/<n>/manifest/requires/<key> must be a semver range` | `node` or `repometry` is not a valid range. |
| `plugins/<n>/manifest/requires/tools must be a list of unique executable names` | `tools` has a repeated name, or a name with a path separator. |
| `plugins/<n> declares an invalid options schema: <reason>` | `optionsSchema` is not a valid JSON Schema. |
| `plugins/<n>/manifest/include/<m> must be a repository-relative path or glob. Received "<glob>".` | A glob breaks the [glob rules](cli.md#scope). |

### Registration

| Message | Meaning and fix |
| --- | --- |
| `Invalid or duplicate operation: <key>` | An operation `id` is empty, has a `/`, or repeats in its plugin. |
| `Invalid operation scope: <key>` | `scope` is neither `file` nor `repository`. |
| `Undeclared output for <key>: <contract>` | Add the output contract to `produces`. |
| `Invalid or duplicate product for plugin <id>` | A product is malformed or declares a contract twice. |
| `Missing or invalid product schema for <contract> in plugin <id>` | Add a `valueSchema`, or use a rows contract. |
| `Invalid metric descriptors for <contract> in plugin <id>` | A metric field is missing or out of range. |
| `Duplicate metric <metric> in plugins <a> and <b>` | Two plugins declare one metric ID. Use a distinct ID. `in plugin <id>` means one plugin declares it twice. |
| `Check <check> in plugin <id> references undeclared metric <metric>` | The `measure` of a check names a metric that no product declares. |
| `Ratio <metric> in plugin <id> references invalid component <component>` | `ratio` names the metric itself or an unknown metric. |
| `<key> outputs <contract>, which only a language provider supplies` | A plugin that is not a language provider outputs `codeStructure` or `codeStructures`. |
| `<key> outputs <contract>, which only the host supplies` | An operation outputs a host contract. Declare your own contract. |
| `<key> reads <contracts>, which no plugin outputs` | An input contract has no producer. Add the producer, or use a host contract. |
| `<key> reads <contracts>, which no phase of its runs offers together` | No step supplies all these inputs. Read fewer inputs, or split the work. |
| `<key> reads <contracts>, which only operations that never run output` | The producers cannot run, for example in a cycle. Fix the producers first. |
| `Language plugin <id> must declare languages with include patterns and provide exactly one code structure operation` | A `language` plugin has no `languages` or no single provider operation. |
| `Language plugin <id> declares multiple languages for <path>` | The `include` globs of one plugin's languages overlap on a file. |
| `Parsers <a> and <b> both include <path>` | Two chosen providers of different languages select one file. Narrow the `include` globs. |
| `parsers/<language> is required to choose among <a>, <b>` | Several plugins provide one language, and `parsers` has no entry for it. [Parsers](cli.md#parsers) lists the other `parsers` messages. |

### During the analysis

| Message | Meaning and fix |
| --- | --- |
| `Missing input <key>.<port> (<contract>)` | No operation that runs for the file outputs the contract. Often the producer's plugin does not select the file. |
| `Ambiguous input <key>.<port> (<contract>)` | Two operations output the contract in one step. Output different contracts. |
| `Conflicting product schemas: <contract>` | Two plugins declare a `report` product for one contract with different schemas. Use one schema, or different contracts. |
| `Invalid product schema for <key>` | The `valueSchema` of the operation's product is not a valid JSON Schema. It is found when the operation is first planned for a file. |

These four stop the analysis. The errors below are recorded as diagnostics in the report, and the analysis goes on.

| Message | Meaning and fix |
| --- | --- |
| `Undeclared input contract: <port> (<contract>)` | `read` used a port or contract that the operation does not declare. |
| `Invalid input: <port> (<contract>)` | The input did not pass `accepts`. |
| `Invalid output for <contract>` | The returned value did not pass `accepts`. For a finding, a missing `check` causes it. |
| `Output violates the schema for <contract>` | The value does not match the product `valueSchema`. |
| `Undeclared metric from <key>: <metric>` | A row uses a metric that the product does not declare. |
| `A finding may only name its reporting plugin <id>` | A finding's `plugin` is not the plugin's own ID. |
| `Plugins in <category> do not produce findings` | A `coverage` plugin returned a finding. |
| `Unavailable inputs: <ports>` | An input operation failed or has no value. |

Docker plugins add the failures in [Docker plugins](process-plugins.md#failures).
