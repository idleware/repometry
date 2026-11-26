<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/idleware/repometry/master/.github/assets/readme-header-dark.svg">
    <img src="https://raw.githubusercontent.com/idleware/repometry/master/.github/assets/readme-header-light.svg" alt="repometry" width="287" height="48">
  </picture>
</h1>

<p align="center">Track repository metrics without SaaS</p>

<p align="center">
  <a href="https://idleware.github.io/repometry/"><img src="https://idleware.github.io/repometry/maintainability.svg" alt="Maintainability"></a>
  <a href="https://idleware.github.io/repometry/"><img src="https://idleware.github.io/repometry/coverage.svg" alt="Coverage"></a>
  <a href="https://idleware.github.io/repometry/"><img src="https://idleware.github.io/repometry/security.svg" alt="Security"></a>
</p>

Git can serve as a project’s single source of truth for code, tests, docs, and CI configuration. Repometry lets you keep coverage and maintainability metrics alongside your code, commit by commit.

## Demo 
[https://idleware.github.io/repometry/](https://idleware.github.io/repometry/)

## Requirements

Node.js >=24

## Install

```sh
# Run without installing.
npx repometry help

# Or install the repometry command.
npm install --global repometry
```

## Usage

Run these commands in your repository. Without an install, start each with `npx`.

| Command | What it does |
| --- | --- |
| `repometry analyze` | Analyze HEAD and save its inspection under `.repometry/`. |
| `repometry analyze HEAD~50..HEAD --skip-saved` | Build history for the last 50 commits, oldest first, skipping saved inspections. A long range uses every core; `--concurrency N` sets a limit. |
| `repometry analyze --import lcov=coverage/lcov.info --import sarif=results.sarif` | Import coverage and scanner results. Repeat `--import` for each file. |
| `repometry view` | Open the report locally on a free port. Use `--port 3030` to choose a port. |
| `repometry report html` | Export a static report to `.repometry/report/html`. Use `repometry report html=DIR` for another folder. |
| `repometry review origin/main --import lcov=coverage/lcov.info` | Report the issues a change adds or worsens on the lines it changes, and their coverage. |
| `repometry store check --repair --from git:origin/repometry` | Check saved inspections. `--repair` restores missing data from a copy. |
| `repometry history` | List saved inspections. `show REVISION` prints one report. See [Reading inspections](docs/store.md#reading-inspections). |
| `repometry projects DIR` | Build an index page for a folder of exported reports. See [Projects index](docs/cli.md#projects-index). |
| `repometry plugins` | List supported formats. |
| `repometry help analyze` | Get help for a command. |

A report shows everything the store holds, so publish it only where you would publish that data.

## License

[MIT](LICENSE)
