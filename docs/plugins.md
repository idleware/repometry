# Write a plugin

A plugin adds files, measurements, findings or languages to an analysis. This page gives the rules for plugin authors: the object to write, what Repometry supplies, what it runs, and the errors it reports.

## What a plugin is

A plugin is an object with an `id`, a `version` and a list of operations. Each operation reads named inputs and returns one value. Repometry plans the operations, runs them, and saves what they return in the report.

There are two ways to add a plugin:

| Way | How | Kinds of plugin |
| --- | --- | --- |
| Process plugin | Name a local Docker image and a command in `repometry.config.json`. | A language provider only. |
| In-process plugin | Pass `plugins` in the `inspect` request from `repometry`. Import the contracts and types from `repometry/plugin`. | Any kind. |

[Configure a process language plugin](process-plugins.md) shows the configuration. The `processPlugin` function from `repometry/plugin` also turns a command into a plugin object that you pass to `inspect`.

`measureDiffCoverage` accepts `plugins` only to decide which files are source files. It runs built-in operations only, so pass the same language plugins to `inspect` and `measureDiffCoverage` to select the same paths.

## Versions

Every plugin sets `api` to `pluginApi`, which is `'repometry.plugin/v1'`.

- Repometry accepts exactly this one value. It has no range and no negotiation. Any other value fails with `Unsupported plugin API for <id>: <api>`.
- The report stores the `api` of every plugin it used, in its applied configuration. For products with `persistence: 'cache'`, `api` is also part of the cache key.
- A process plugin in `repometry.config.json` has no `api` key. Repometry sets it.
- Each process request carries `protocol: "repometry.plugin-process/v1"`, which is `processPluginProtocol`. The process does not answer with a version, and Repometry does not check one.

The compatibility rule: within v1, Repometry may add optional plugin fields, optional request fields and new contracts. It does not remove or rename a field, change what a field means, or make an optional field required. A change of that kind gets a new version string. A process plugin must ignore request fields that it does not know.

## The plugin object

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Names the plugin. It is not empty, has no `/`, and is unique among all plugins. A built-in plugin's ID is an error. |
| `version` | string | yes | Your version of the plugin. It is saved in the report and is part of the cache key. |
| `api` | string | yes | Must equal `pluginApi`. |
| `kinds` | list | yes | At least one of `language`, `analysis`, `coverage`, `security`, `import`, `source`. `language` is required for `providesLanguages`. A `security` plugin counts as a security scanner, and the report marks its metrics private. The other kinds label the plugin. |
| `operations` | list | yes | The [operations](#operations). |
| `produces` | list | yes | The [products](#products) the operations output. |
| `claims` | object | no | The files the plugin works on. See [Claims](#claims). |
| `providesLanguages` | list | no | The languages the plugin parses. See [Languages](#languages). |
| `rules` | list | no | The [rules](#rules) the plugin reports. |
| `tools` | object | no | Tool name to version, such as `{ "node": "26" }`. Saved in the report and part of the cache key. A process plugin must list at least one. Use exact versions, and for a process plugin a versioned image or an image digest, so that a rerun uses the same tool. |
| `settings` | JSON value | no | The effective, non-secret settings. Saved in the report. It must be JSON data and must match `config` when both are set. |
| `config` | JSON Schema or boolean | no | The schema that `settings` must match. |

### Operations

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Not empty, no `/`, unique in the plugin. The full key is `<plugin>/<operation>`. |
| `role` | `'provider'` or `'inspection'` | yes | An inspection reads files and returns results for the report. A provider returns data for other operations. A language provider's parse operation is a provider. |
| `scope` | `'file'` or `'repository'` | no | Default `file`. A file operation runs once for each file. A repository operation runs once for all the files the plugin claims. |
| `fileIndependent` | boolean | no | For a repository provider that returns the same results for a file whatever other files it receives. See [process plugins](process-plugins.md). |
| `inputs` | object | yes | Port name to contract. Port names are yours. Repometry matches by contract ID. |
| `output` | contract | yes | What `execute` returns. It must be declared in `produces`. |
| `implementation` | string | no | A fingerprint for details the versions and inputs do not carry. Part of the cache key. |
| `execute(inputs)` | function | yes | Returns the value or a promise of it. |

A contract is `{ id, accepts }`, where `accepts` is a type guard. Repometry checks every input and the output with it.

`execute` receives:

- `inputs.read(port, contract)` returns the input on that port. The contract must be the one declared for the port, or the call throws `Undeclared input contract`.
- `inputs.emitDiagnostic?.(message, path?)` records a warning. The results stay valid, and the inspection becomes partial. `path` defaults to the file the operation runs on. A repository operation has no default. An operation that emits a diagnostic is not written to the operation cache. Call it with `?.`, because the type marks it optional.

A thrown error or a rejected promise fails the operation. The report records it as a diagnostic, and the analysis goes on. Operations that read its output are blocked.

### Products

`produces` declares every contract that an operation outputs.

| Field | Meaning |
| --- | --- |
| `contract` | The contract ID. |
| `persistence` | `report` saves the value in the report. `cache` keeps it in the operation cache. `transient` passes it to other operations only. |
| `schema` | A JSON Schema, or a boolean, that the value must match. |
| `metrics` | The metrics that the rows of this product use. |

A `report` or `cache` product needs a `schema`, except for the rows contracts: `measurements` and `findingResult`, or a `report` product that declares `metrics`. A `transient` product needs none. A `report` product with a schema must be JSON data.

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

Repometry reuses the result of an operation whose product has `persistence: 'cache'`. The operation must depend only on its input data, its effective settings and its declared tools. Pass `operationCache` with a `store` and a `configurationDigest` to `inspect`. The digest identifies the effective settings that the inputs do not carry. `LocalOperationCache` from `repometry/plugin` writes atomically to a directory such as `.repometry/cache/operations`. The key covers the Node.js version, the operation, `api`, `version`, `tools`, `settings`, `scope`, `implementation`, the contract and schema, and the complete input values. Cacheable input values are plain records, arrays, primitives and byte arrays. A miss, an invalid entry or an input of another kind runs the operation. Cache products are stored apart from the report.

### Rules

A rule descriptor names a finding rule that the plugin reports. The report saves the descriptors with the plugin ID.

| Field | Meaning |
| --- | --- |
| `id`, `category` | Required. Duplicate IDs are an error. |
| `description` | Optional text. |
| `defaults` | Optional `{ limit, cost }`, numbers of 0 or more. |
| `measure` | Optional. A metric ID the plugin declares. An unknown ID is an error. |
| `per` | Optional pair of words: the unit in singular and plural. |

A rule in the `structure` or `duplication` category is skipped for a file whose language provider does not measure `structuralRules` or `duplication`. The report records the skip in `ruleSkips`.

### Claims

`claims` selects the files a plugin works on: `extensions` (each like `.ts`), `globs` and `languages` (language IDs). A file matches when any of them matches. Without claims, the plugin works on every file. `scanOnly: true` runs inspections for matching files without counting them as analysed in the inventory. Each list holds unique, non-empty strings.

An operation that does not read the code structure runs only on text files of at most 1 MiB. A larger file gets the diagnostic `Plugin inspection skipped a file larger than 1 MiB`.

### Languages

A language provider turns files into a code structure. The plugin has the kind `language`, claims files or lists `providesLanguages`, and has exactly one provider operation. The operation reads `sourceFile` and outputs `codeStructure`, or has `scope: 'repository'`, reads `sourceFiles` and outputs `codeStructures`. [Language provider metrics](metrics.md) describes the fields of a structure.

Each entry in `providesLanguages` has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and `-`, starting with a letter. Unique within the plugin. Another plugin may provide the same language. |
| `label` | The display name. |
| `color` | Optional, six hexadecimal digits with `#`. |
| `extensions`, `globs` | At least one. They select the files of the language. |
| `measures` | Optional. A subset of `functions`, `cyclomaticComplexity`, `cognitiveComplexity`, `classes`, `commentLines`, `codeLines`, `duplication`, `structuralRules`. `duplication` needs `codeLines`. Repometry removes the other optional fields from the structures of this language before any operation reads them. |
| `syntax` | Optional data for the report viewer: `lineComments`, `blockComments`, `strings`, `stringPrefixes`, `keywords`, `regexAfter`. The [syntax table](process-plugins.md) gives the meaning of each. |

One provider handles each file. Two chosen providers that claim one file are an error. Several plugins may provide one language, for example `go`. The user's `parsers` setting chooses which of them parses it, so a plugin does not need to avoid IDs that other plugins use; [Parsers](cli.md#parsers) describes the rule. The report stores the language catalog once and records the provider operation for each source path. It also lists each distinct operation binding that ran in its applied configuration (`operations`): the key, the binding of each input, `implementation` and, for a repository operation, `scope`.

## Host contracts

The host supplies these contracts. An operation reads them as inputs.

| Contract | ID | Exported from `repometry/plugin` | Supplied |
| --- | --- | --- | --- |
| `sourceFile` | `repometry.source-file/v1` | yes | For each file the plugin claims. A file with `path` and `bytes`. In a working-tree run, the files are the tracked files and the untracked files that Git does not ignore. |
| `codeStructure` | `repometry.code-structure/v1` | yes | For each file that a language provider parsed, together with `sourceFile`. |
| `sourceFiles` | `repometry.source-files/v1` | yes | Once, to repository operations, with the files the plugin claims. The same files as for `sourceFile`. |
| `cloneSources` | `repometry.clone-sources/v1` | no | Once, after the files. |
| `lcovInput` | `repometry.lcov-input/v1` | no | Once, after the files, and only when coverage is imported. |
| `changesInput` | `repometry.git-line-changes/v1` | no | Only in a diff coverage run. Only built-in operations run there. |

The module also exports `measurements` and `findingResult` for outputs, `codeStructures` for repository providers, and the types of all of them. A plugin cannot import the contracts that are not exported, so it cannot read them. `changesInput` is never available to a plugin.

## How Repometry decides what runs

An analysis has three steps: the files, one at a time; the repository; and the run after the files. Each step supplies the host contracts of the table above that fit it.

1. An input is satisfied in a step by a host contract the step supplies, or by the output of another operation that runs in the same step. A product reaches only the operations of its own step.
2. An operation runs in the first step where all its inputs are satisfied.
3. The scope must fit the step. A file operation runs in the file step, and a repository operation in the repository step. An operation that reads only what the after-files step supplies runs once, whatever its scope.
4. An operation is left out, without an error, only when this run lacks a host input that it reads. The case is coverage that was not imported. An operation that reads the output of such an operation is left out too.
5. Every other operation that no step satisfies is an error. This includes inputs that no plugin outputs, inputs that no single step offers together, and cycles.
6. When two candidates could satisfy one input, the input is ambiguous. This is an error.

A reader of the code structure is an operation that reads `codeStructure`, directly or through the products of other operations. It runs only on files that have a language provider, limited to the files its plugin claims. Without claims it runs on all parsed files. A reader that claims only Markdown runs on no file, and that is not an error. If the provider fails on a file, the reader is blocked there, and the report records `Unavailable inputs`.

Only a language provider supplies a file's code structure. Any other operation that outputs `codeStructure` or `codeStructures` is an error. A plugin that needs its own facts declares its own contract.

An operation that reads the product of another plugin runs on a file only when both plugins claim that file. When the reader's plugin claims a file that the producer's plugin does not, the analysis stops with `Missing input <key>.<port> (<contract>)`. A file that only the producer claims does not run the reader.

## Errors

Repometry rejects an invalid plugin before the analysis starts. `<key>` stands for `<plugin>/<operation>`. The messages call a step a phase.

### Registration

| Message | Meaning and fix |
| --- | --- |
| `An additional plugin uses a built-in plugin ID` | The `id` belongs to a built-in plugin or language. Rename it. |
| `Unsupported plugin API for <id>: <api>` | `api` is not `pluginApi`. |
| `Invalid or duplicate plugin ID: <id>` | The `id` is empty, has a `/`, or repeats. |
| `Invalid or duplicate operation: <key>` | An operation `id` is empty, has a `/`, or repeats in its plugin. |
| `Invalid operation scope: <key>` | `scope` is neither `file` nor `repository`. |
| `Undeclared output for <key>: <contract>` | Add the output contract to `produces`. |
| `Plugin settings must be JSON data: <id>` | `settings` holds a value that JSON cannot carry. |
| `Plugin settings violate the configuration schema: <id>` | `settings` does not match `config`. |
| `Duplicate metric <metric> in plugins <a> and <b>` | Two plugins declare one metric ID. Use a distinct ID. `in plugin <id>` means one plugin declares it twice. |
| `Missing plugin manifest for <id>. Declare kinds and produces.` | The plugin has none of `kinds`, `produces`, `claims` and `providesLanguages`. |
| `Plugin <id> must declare languages in claims.languages` | The plugin has a top-level `languages` property. Move it into `claims`. |
| `Invalid kinds for plugin <id>` | `kinds` is empty, repeats, or holds an unknown kind. |
| `Invalid file claims for plugin <id>` | A claim has an unknown key, a repeated or empty string, an extension that is not `.name`, or a `scanOnly` that is not boolean. |
| `Invalid provided languages for plugin <id>` | The plugin lacks the `language` kind, or an entry has a bad `id`, `label`, `color`, `syntax` or `measures`, no extension or glob, or a repeated `id`. |
| `Plugin <id> must declare its products` | `produces` is not a list. |
| `Invalid or duplicate rules for plugin <id>` | A rule descriptor is malformed or repeats an `id`. |
| `Invalid configuration schema for plugin <id>` | `config` is neither a boolean nor an object. |
| `Invalid or duplicate product for plugin <id>` | A product is malformed or declares a contract twice. |
| `Missing or invalid product schema for <contract> in plugin <id>` | Add a `schema`, or use a rows contract. |
| `Invalid metric descriptors for <contract> in plugin <id>` | A metric field is missing or out of range. |
| `Rule <rule> in plugin <id> references undeclared metric <metric>` | Declare the metric in a product. |
| `Ratio <metric> in plugin <id> references invalid component <component>` | `ratio` names the metric itself or an unknown metric. |
| `<key> outputs <contract>, which only a language provider supplies` | A plugin that is not a language provider outputs `codeStructure` or `codeStructures`. |
| `<key> outputs <contract>, which only the host supplies` | An operation outputs a host contract. Declare your own contract. |
| `<key> reads <contracts>, which no plugin outputs` | An input contract has no producer. Add the producer, or use a host contract. |
| `<key> reads <contracts>, which no phase of its runs offers together` | No step supplies all these inputs. Read fewer inputs, or split the work. |
| `<key> reads <contracts>, which only operations that never run output` | The producers cannot run, for example in a cycle. Fix the producers first. |
| `Language plugin <id> must claim files and provide code structure` | Add claims or `providesLanguages`, and one provider operation. |
| `Language plugin <id> declares multiple languages for <path>` | The languages of one plugin overlap on a file. |
| `Multiple language providers claim <path>: <a>, <b>` | Two chosen providers of different languages claim one file. Narrow the claims. |
| `Config parsers/<language> is required to choose among <a>, <b>` | Several plugins provide one language, and `parsers` has no entry for it. [Parsers](cli.md#parsers) lists the other `parsers` messages. |

### During the analysis

| Message | Meaning and fix |
| --- | --- |
| `Missing input <key>.<port> (<contract>)` | No operation that runs for the file outputs the contract. Often the producer's plugin does not claim the file. |
| `Ambiguous input <key>.<port> (<contract>)` | Two operations output the contract in one step. Output different contracts. |

Two more messages stop the analysis, at the same point:

| Message | Meaning and fix |
| --- | --- |
| `Conflicting product schemas: <contract>` | Two plugins declare a `report` product for one contract with different schemas. Use one schema, or different contracts. |
| `Invalid product schema for <key>` | The `schema` of the operation's product is not a valid JSON Schema. It is found when the operation is first planned for a file. |

These four stop the analysis. The errors below are recorded as diagnostics in the report, and the analysis goes on.

| Message | Meaning and fix |
| --- | --- |
| `Undeclared input contract: <port> (<contract>)` | `read` used a port or contract that the operation does not declare. |
| `Invalid input: <port> (<contract>)` | The input did not pass `accepts`. |
| `Invalid output for <contract>` | The returned value did not pass `accepts`. |
| `Output violates the schema for <contract>` | The value does not match the product `schema`. |
| `Undeclared metric from <key>: <metric>` | A row uses a metric that the product does not declare. |
| `Unavailable inputs: <ports>` | An input operation failed or has no value. |

## Process plugin failures

[Configure a process language plugin](process-plugins.md) describes the request and the output. This section lists what happens when a process plugin fails.

Repometry rejects a configured plugin with one of these messages:

| Message | Meaning |
| --- | --- |
| `Config plugins<path> <reason>` | The entry does not match the [schema](../packages/repometry/src/main/resources/config/process-plugins-v1.schema.json). The path names the field. |
| `Config plugins/<n>/id duplicates plugin <id>` | The `id` belongs to another configured plugin or a built-in one. |
| `Config plugins/<n>/command/0 must name an executable` | The command is empty. |
| `Config plugins/<n>/providesLanguages/<m> must claim an extension or glob` | A language has no selector. |
| `Config plugins/<n>/claims/<key> must match the claims of its languages` | The top-level selectors differ from the combined ones. |

A run fails in these ways:

- A nonzero exit code fails the operation with `Process plugin exited with code <n>`, followed by the last three non-empty lines of stderr. Repometry cuts each line to 240 characters. It replaces a line that looks like a credential assignment with `[redacted tool output]`, and it hides credentials in URLs and token-like strings. It does not read stdout.
- Exit codes 125, 126 and 127 give `Docker could not start the tool (exit code <n>)`. A plugin that exits with one of these codes gets this message too.
- When `timeoutMs` passes, Repometry kills the process with `SIGKILL` and reports `Tool timed out`. The default is 30 seconds.
- When stdout and stderr together exceed `maxOutputBytes`, the result is `Tool exceeded the output limit`. The default is 8 MiB.
- stdout must be JSON Lines. Blank lines are ignored. A line that is not a JSON object gives `Invalid JSON Lines output from the process plugin` or `Invalid process plugin output record`.
- The output holds exactly one `product` record with the declared contract and a JSON value. A second product, another contract or an unknown `kind` gives `Expected one declared product from the process plugin`. No product gives `Missing declared product from the process plugin`. The value must also pass the contract, or the operation fails with `Invalid output for <contract>`.
- A `diagnostic` record needs a non-empty `message`, or the result is `Invalid process plugin diagnostic message`. With no `severity` or `info`, Repometry ignores it. `warning` records a warning without a path. `error` fails the operation with the message. Another severity gives `Invalid process plugin diagnostic severity`.
- An input that is not JSON data fails with `Process input must be JSON data: <plugin>/<operation>.<port>`.

The sandbox is fixed. The command runs from a local image with `docker run --rm --pull never`. It has no network, a read-only root file system, no capabilities and `no-new-privileges`. The user is the caller's user and group. `/tmp` is a writable temporary file system, and `HOME` is `/tmp`. Proxy variables are empty. The input files are mounted read-only at `/snapshot`, which is the working directory. The image entrypoint is replaced by the first element of `command`, and the other elements are its arguments. The limits `memoryBytes` and `pidsLimit` apply. The files that the request names are the only files in the snapshot.

From the library, `processPlugin(manifest, runner)` takes a plugin manifest. Each operation lists `argv`, `timeoutMs` and `maxOutputBytes` instead of `execute`. `new DockerToolRunner(image, { memoryBytes, pidsLimit })` runs it in a local image. `processPlugin` rejects a runner with networking enabled, and a manifest whose `tools` is empty or holds an empty version.

## Example

An in-process inspection that reads the code structure and reports one finding for each complex function:

```ts
import { inspect } from 'repometry';
import { codeStructure, findingResult, pluginApi } from 'repometry/plugin';
import type { Finding, Plugin } from 'repometry/plugin';

const limit = 10;

const complexFunctions: Plugin = {
  id: 'complex-functions',
  version: '1.0.0',
  api: pluginApi,
  kinds: ['analysis'],
  claims: { extensions: ['.ts', '.js'] },
  rules: [{ id: 'complex-function', category: 'lint', description: 'A function with a high cyclomatic complexity.' }],
  produces: [{ contract: findingResult.id, persistence: 'report' }],
  operations: [{
    id: 'check',
    role: 'inspection',
    inputs: { structure: codeStructure },
    output: findingResult,
    execute(inputs) {
      const { path, cyclomaticFunctions = [] } = inputs.read('structure', codeStructure);
      const findings = cyclomaticFunctions.flatMap((fn): Finding[] => fn.value > limit && fn.line !== undefined ? [{
        tool: 'complex-functions',
        rule: 'complex-function',
        category: 'lint',
        level: 'low',
        message: `${fn.name ?? '(anonymous)'} has a complexity of ${fn.value}.`,
        path,
        line: fn.line,
        value: fn.value,
        limit,
      }] : []);
      return { measurements: [], findings };
    },
  }],
};

const report = await inspect({
  directory: '.',
  output: '.repometry',
  source: { workingTree: true },
  plugins: [complexFunctions],
});
```

The operation reads `codeStructure`, so it runs on the parsed `.ts` and `.js` files that the plugin claims. The product uses `findingResult`, a rows contract, so it needs no `schema`.
