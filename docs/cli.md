# Commands and settings

This page covers the rules that settings follow, the `projects` command, the `components` key, exit codes and the environment variables that the [README](../README.md#usage) leaves out. [Reading inspections](store.md#reading-inspections) describes `history` and `show`.

## Analysis settings

- `analyze` with no revision analyses `HEAD`. Use `analyze REVISION` to analyse another commit, or `--working-tree` for the working directory.
- `--branch NAME` on `report` and `view`, or `branch` in `repometry.config.json`, only names the branch the report shows. It never selects a commit.
- An option given on the command line replaces the same key in `repometry.config.json`; the config's value is not merged with it. This holds for `--import` and `imports`, `--exclude` and `exclude`, `--branch` and `branch`, `--sources` and `sources`, and for the formats typed after `report` and `reports`. `--no-config` skips the config file.
- `analyze BASE..HEAD` rejects `--import`, because an import describes one checkout. It skips the config's `imports` and says so on stderr.
- A path typed on the command line resolves against the folder the command runs in, or against `--repo DIR` (`-C DIR`) on a command that takes it. This covers `--import`, `--store`, `--config` and the path in `report FORMAT=PATH`. A path in `repometry.config.json` resolves against the repository root, wherever the command runs. This covers the paths in `imports` and `reports`.
- A command takes `--repo` and `--store` only when it uses them. `analyze`, `show`, `history`, `report` and `store check` take both. `review` and `plugins` take `--repo`. `view` takes `--store`, and its `TARGET` says where to look. `projects` and `cache` take neither. Any other command rejects the option as unknown.

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
