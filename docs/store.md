# Store format

Repometry saves inspections in a store. By default the store is the `.repometry/` folder at the root of your repository. Use `--store PATH` for another folder, or `--store git:REF` to read a storage branch such as `repometry`. This page describes the files in a store, for reading them or building tools on them. Let Repometry write them.

## Layout

- `commits/<sha>/report.json` holds the inspection of one commit. The folder name is the full commit ID.
- `working-trees/<id>/report.json` holds an inspection made with `analyze --working-tree`. The ID is a SHA-256 digest of the analysed files' paths and contents.
- `objects/<2 hex>/<content id>-<path hint>.json` holds the parts that report files refer to.
- `summary.json` lists a summary row for each saved commit.
- `reviews/<number>.json` holds a pull request review saved by Repometry 0.8 and earlier. The viewer still lists these files. `repometry review` no longer saves anything.
- `manifest.json` marks a store. Repometry writes it when it first saves into a store that has none. A store saved by Repometry 0.10 or earlier may have none and stays readable, but reading a storage branch with `--store git:REF` requires it.

Other files in `.repometry/`, such as the `report/` folder that `repometry report` writes by default, are not part of the store. Repometry reads no `components.json` there; [components](cli.md#components) belong in `repometry.config.json`. The store has no cache folder. `repometry view` keeps the source files it reads from Git in a system cache. `repometry cache path` prints where, and `repometry cache clear` empties it. `REPOMETRY_CACHE_DIR` moves it to another folder.

All files are UTF-8 JSON. Repometry writes each report file, object and `summary.json` under a temporary name and renames it into place, so a reader never sees a partly written file. It writes a report's objects before the report file that names them.

## Report files

A commit's report file has two lines. The first line opens the JSON object with the schema and the commit's summary row, and ends with a comma. The second line holds the rest of the object.

```text
{"schema":"urn:repometry:schema:report-store:1","summary":{"sha":"…","revision":"…",…},
"profile":"…","tree":"…","report":{…}}
```

To read only the summary row, take the first line, replace its final comma with `}` and parse it. The row is the one `summary.json` lists for the commit, with the commit's own metric catalog. Its `revision` is the SHA-256 digest of the rebuilt report serialized with `JSON.stringify`. Readers compare the two.

A working tree's report file is a single line without a summary row.

The rest of the object has three fields:

- `profile` is the ID of the profile object.
- `tree` is the ID of the root directory object.
- `report` is the report, with schema `urn:repometry:schema:report:2`, without the parts kept in objects.

In `report`, `appliedConfig` keeps only `churnWindow`, the value that describes this commit's Git history. `definitions` is `null`, and so is every entry of `pluginData` other than `products` and `inventory`. The profile object holds their values.

The report keeps some field names that differ from the terms of the [configuration](cli.md#configuration) and of [Write a plugin](plugins.md). A finding names its plugin in `tool` and its check in `rule`, and so does an entry of `appliedConfig.findingIgnore`. `ruleSkips` lists the skipped checks. A plugin's entry in `appliedConfig.plugins` has `api` for the manifest `schema`, `kinds` for the `category`, `claims` for `include`, `settings` for the `options` and `providesLanguages` for `languages`. The names stay as they are so that every saved report stays readable.

The row lists are `measurements`, `findings`, `ruleSkips`, `pluginData.inventory` and each list under `pluginData.products`. A row that names no file stays in the list as it is. Rows of files are replaced by `[first, count]` entries. An entry stands for `count` consecutive files starting at index `first` in the sorted list of the tree's file paths, and each of those files contributes its next run of rows for that list. Expanding the entries in order gives the rows in their saved order. Paths sort by UTF-16 code units.

Line coverage, the `repometry.lcov-lines/v1` product, is a single row for the whole commit, so it stays in the report file.

## Objects

An object's name has two parts:

- The content ID is the first 32 hexadecimal digits of the SHA-256 digest of the object's bytes.
- The path hint is the first 8 hexadecimal digits of the SHA-256 digest of the path the object describes: `/` for the root directory, `/src/` for a directory, `/src/a.js` for a file, and an empty string for a profile.

The folder under `objects/` is the first two digits of the path hint, so every version of one path's object is in the same folder. An object never changes. Its name follows from its content and its path, so a file whose results stay the same across commits is stored once, and copying objects from one store into another never conflicts.

Reading a commit's report checks the rebuilt report against the `revision` in its summary row. `store check` also checks each object against its content ID. Nothing checks the path hint.

There are three types of objects:

- A profile object is `{"appliedConfig": …, "definitions": …, "catalog": …}`. It holds the applied configuration with `churnWindow` set to `null`, the metric definitions, and the `pluginData` catalog entries when the report has plugin data. Commits with the same configuration, definitions and catalog share it. The applied configuration is the profile: it lists the plugins that took part, their tools with versions, and the file selectors of the languages present. A parser plugin counts only when it parsed a file, and its `tools` list only the grammars it used, such as `tree-sitter-go`. A change to any of these starts a new profile, and the viewer marks it in Trends. [Go and Python analysis](native-languages.md#profile) gives an example.
- A directory object is an array of `[name, entry]` pairs sorted by name. A subdirectory's name ends with `/`, and its entry is the ID of its directory object. A file's entry is an object with an optional `inventory`, the file's inventory rows, and an optional `data`, the ID of its data object.
- A data object maps list names to the file's runs of rows. The names are `measurements`, `findings`, `ruleSkips` and `products/<contract>`. Each run is an array of rows, in the order the report file's entries use them. A row keeps its keys in order, with `"path": 0` in place of the path. Inventory rows in a directory object use the same runs.

To rebuild a report, read the profile object and the root directory object. Walk the directory objects to collect the file paths, their inventory rows and their data objects. Then expand each `[first, count]` entry in order, set each row's `path`, and put back the profile's parts.

## Summary

`summary.json` has schema `urn:repometry:schema:repository-summary:1`. Its `commits` array holds the summary rows of all saved commits, newest first. The rows' metric catalogs are merged into one `metrics` array at the root, and each row's `values` are keyed by position in that array.

Repometry rewrites `summary.json` whenever `analyze` saves commits. Reading a local store doesn't need it. Reading a storage branch uses it when it lists exactly the commits the branch holds, and otherwise reads the first line of each commit's report file.

## Storage branch

A storage branch holds a store at its root, along with `manifest.json`, which `analyze` writes on its first save into a store:

```json
{
  "schema": "urn:repometry:schema:metabranch:1"
}
```

Pass `--store git:REF` to read a store straight from Git, without a checkout. `REF` is anything Git resolves to a commit or a tree, such as `repometry`, `origin/repometry` or a commit ID. Repometry resolves the tree once and reads everything from it, so a push during the read doesn't mix versions. It refuses a tree without the manifest, and it reads only commit reports.

```sh
git fetch origin repometry
npx repometry history --store git:origin/repometry
npx repometry report html --store git:origin/repometry
```

A storage branch is read-only for Repometry. `analyze` and `store check` need a local store. [Publish metrics from CI](ci.md) shows how a workflow adds inspections to the branch.

## Reading inspections

These commands print JSON and read the store that `--store` selects, a storage branch included.

| Command | What it prints |
| --- | --- |
| `repometry history` | A summary of each saved inspection. |
| `repometry show HEAD` | The saved report of a commit. `show` takes a revision or a working tree's digest. |
| `repometry show HEAD --files` | The metrics of each file in that report. |

`show` reads saved inspections only. Run `repometry analyze` on a commit first.

## Reports saved before 0.8.0

Before 0.8.0, a commit's report file held the whole report and referred to no objects. Its first line carries the same summary row under schema `urn:repometry:schema:compact-json:1`, and the rest encodes the report as compact JSON:

- `strings` lists the strings, and `shapes` lists the key lists of objects.
- In `data`, `null`, booleans and numbers stand for themselves. `[0, i]` is string `i`, `[1, …]` is an array, and `[k, …]` with `k` of 2 or more is an object with the keys of shape `k − 2`.

Repometry reads these files as they are, and no command rewrites them. It also reads a file that holds a plain report with schema `urn:repometry:schema:report:2`. A store can mix all types. Analysing such a commit again without `--skip-saved` saves its report in the current layout.

## Checking a store

```sh
npx repometry store check
```

`store check` reads every saved report. It checks that each object the report needs exists and matches its content ID, that the report rebuilds and is valid, that it belongs to the commit or working tree its folder names, and that it matches the `revision` in its summary row. A report saved before 0.8.0 gets the same checks without objects. The command also compares `summary.json` with the saved commits.

The result has schema `urn:repometry:schema:store-check:1`. It counts the `reports`, the `objects` they reach and the `unreferenced` objects that no report reaches. `summary` is `current` or `stale`. `problems` lists each broken report as `missing-objects` or `corrupt-objects` with the object IDs, or as `unreadable` with the error. The command exits with 0 when it finds no problem, with 3 when it finds one, and with 1 when it cannot run. [Exit codes](cli.md#exit-codes) lists the codes of every command.

`--repair` fixes what it can:

- With `--from`, it copies missing and corrupt objects from another store (`--from PATH`) or a storage branch (`--from git:REF`). It copies only objects whose content matches their ID.
- When no report is broken, it removes unreferenced objects older than an hour. Newer ones may belong to an analysis that is still saving.
- It rewrites a stale `summary.json`.

```sh
git fetch origin repometry
npx repometry store check --repair --from git:origin/repometry
```

The result then adds `repaired`, with the number of objects `restored` and `removed` and whether `summary.json` was rewritten. If a commit's report stays broken, analyse the commit again with `repometry analyze SHA`.
