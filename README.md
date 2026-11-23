# Repometry

> Track repository metrics without SaaS

Git can serve as a project’s single source of truth for code, tests, docs, and CI configuration. Repometry lets you keep coverage and maintainability metrics alongside your code, commit by commit.

## Requirements

Node.js >= 24

## Usage

Run each command in your repository as `npx repometry <command>`.

| Command | What it does |
|---|---|
| `analyze` | Measures HEAD and saves the inspection under `.repometry/` |
| `analyze HEAD~50..HEAD` | Measures the last 50 commits, oldest first, to build history. `--skip-saved` leaves commits already saved. |
| `analyze --import lcov=coverage/lcov.info` | Adds coverage or scanner results from your tools. Repeat `--import` for each file. |
| `report html` | Writes the public report (history, aggregates, badges) to `.repometry/report/html` |
| `report html --mode private -o DIR` | Writes the private report, with per-file metrics, findings and source links, to `DIR` |
| `view` | Serves the report locally on a free port; `--port 3030` picks the port |
| `plugins` | Lists the import formats, reporters and CI adapters |
| `help [command]` | Shows the options of a command |

## License

[MIT](LICENSE)
