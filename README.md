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

## Requirements

Node.js 24 or newer.

## Usage

Run these commands in your repository.

```sh
# Analyze HEAD and save its inspection under .repometry/.
npx repometry analyze

# Build history for the last 50 commits, oldest first, skipping saved inspections.
npx repometry analyze HEAD~50..HEAD --skip-saved

# Import coverage and scanner results. Repeat --import for each file.
npx repometry analyze --import lcov=coverage/lcov.info --import sarif=results.sarif

# Open the report locally on a free port. Use --port 3030 to choose a port.
npx repometry view

# Export a static report to .repometry/report/html. Use -o DIR for another folder.
npx repometry report html

# List supported formats and get help for a command.
npx repometry plugins
npx repometry help analyze
```

A report shows everything the store holds, so publish it only where you would publish that data.

## License

[MIT](LICENSE)
