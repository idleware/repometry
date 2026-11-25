# Publish metrics from CI

This guide sets up a GitHub Actions workflow for your project. On each push to the default branch, the workflow analyses the commit with your test coverage, saves the inspection to a `repometry` branch in your repository, and publishes the HTML report and badges to GitHub Pages. Repometry's own [CI workflow](../.github/workflows/ci.yaml) works the same way.

## How it works

The workflow has two jobs:

- `analyze` checks out your code, runs your tests with coverage and analyses the pushed commit. It saves the inspection to an empty store in the runner's temporary folder, and uploads the commit's report file and objects as an artifact.
- `publish` checks out the `repometry` branch, adds the files from the artifact, and commits and pushes them. It then builds the report from every inspection on the branch and pushes the report to the `gh-pages` branch, which GitHub Pages serves.

`analyze` needs no earlier inspections. Each run adds one commit's inspection to the branch, and the report's Trends come from all the inspections on it.

## Why a separate branch

The `repometry` branch shares no history with your code. It holds only the store: a manifest, a report file for each inspected commit, and the objects those files refer to. [Store format](store.md) describes them. Each inspection is a commit on this branch, so your default branch and its history stay as they are.

The data is still part of your repository. It is versioned, it has the repository's access rules, and anyone who can fetch the repository can open the report without a checkout of the branch:

```sh
git fetch origin repometry
npx repometry view --store git:origin/repometry
```

## Set up

1. Add the workflow below as `.github/workflows/metrics.yaml`. Change `main` to your default branch and `npm test` to your test command. The tests must write LCOV to `coverage/lcov.info`, or change the `--import` path to match. For Go and Python coverage, see [Go and Python analysis](native-languages.md#importing-coverage).
2. Push the workflow. Its first run creates the `repometry` and `gh-pages` branches.
3. In your repository's settings, under Pages, choose to deploy from a branch, and select `gh-pages` and its root folder.

The report is then at `https://OWNER.github.io/REPO/`. The badges `coverage.svg`, `maintainability.svg` and `security.svg` are next to it:

```md
[![Coverage](https://OWNER.github.io/REPO/coverage.svg)](https://OWNER.github.io/REPO/)
```

A report shows everything the store holds, and a GitHub Pages site can be public even when its repository is private. Keep security, dependency, secret and infrastructure scanner results out of this workflow, and import them into a local store instead.

## The workflow

```yaml
name: Metrics

on:
  push:
    branches: [main]

permissions: {}

jobs:
  # Runs your tests and dependencies, so it gets a read-only token and no secrets.
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # Git history for churn
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npm ci
      - run: npm test # Your tests. They must write coverage/lcov.info.
      - run: npx --yes repometry@0.8.0 analyze --store "$RUNNER_TEMP/store" --import lcov=coverage/lcov.info
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: repometry
          path: |
            ${{ runner.temp }}/store/commits/${{ github.sha }}
            ${{ runner.temp }}/store/objects
          retention-days: 1

  # Saves the inspection to the repometry branch and publishes the report to gh-pages.
  publish:
    needs: analyze
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency:
      group: repometry
      cancel-in-progress: false
    permissions:
      contents: write
    env:
      GIT_AUTHOR_NAME: github-actions[bot]
      GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
      GIT_COMMITTER_NAME: github-actions[bot]
      GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
    steps:
      # Creates the branch on the first run. Later runs find the same manifest and push nothing.
      - working-directory: ${{ runner.temp }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          printf '{\n  "schema": "urn:repometry:schema:metabranch:1"\n}\n' > manifest.json
          npx --yes ggcp@1.11.0 manifest.json "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git/repometry" \
            --message="chore(metrics): start the repometry data branch [skip ci]"
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: repometry
          fetch-tags: true # release tags for the report
          persist-credentials: false
      # The commit's report file and objects land in place. An object already on the branch has the same bytes.
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: repometry
          path: .
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git add -A
          git diff --cached --quiet && exit 0 # a re-run finds the inspection already pushed
          git commit -qm "chore(metrics): inspect ${GITHUB_SHA::7} [skip ci]"
          git push -q "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:refs/heads/repometry
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npx --yes repometry@0.8.0 report "html=$RUNNER_TEMP/site" --store . --sources github --title "${GITHUB_REPOSITORY#*/}"
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: >-
          npx --yes ggcp@1.11.0 '**/*' "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git/gh-pages"
          --cwd="$RUNNER_TEMP/site" --message="docs: update the repometry report for ${GITHUB_SHA::7}"
```

Use the same Repometry version in both jobs.

## The analyze job

The checkout fetches the whole history with `fetch-depth: 0`. Repometry measures churn from it: how many first-parent commits touched each file in the 90 days up to the inspected commit. With the default checkout of a single commit, the inspection has no churn. A deeper shallow checkout counts only the commits it has. In both cases the report says that the checkout is shallow. Nothing else in the inspection needs earlier commits.

`analyze --store "$RUNNER_TEMP/store"` saves the inspection in an empty store outside your checkout, and `--import` adds your coverage report.

The artifact holds `commits/<sha>`, the commit's report file, and `objects`, the objects it refers to. It leaves out the store's `summary.json`, which would list only this commit. The paths in the artifact start below `store/`, so the files land at `commits/<sha>/report.json` and under `objects/` when the artifact is downloaded into a checkout of the branch.

## The publish job

1. The first step writes the manifest and copies it to the `repometry` branch with [ggcp](https://github.com/antongolub/git-glob-cp). On the first run, the branch doesn't exist, and ggcp creates it with one commit that holds `manifest.json`. Later runs find the same manifest and push nothing.
2. The checkout switches to the `repometry` branch. `fetch-tags: true` brings your tags for the report. Commit titles and authors are saved with each inspection, so the job needs no other history.
3. The artifact is downloaded into the checkout. The report file is new. An object that is already on the branch has the same name and the same bytes, so only new objects show up as changes.
4. The next step commits and pushes the new files. When there is nothing to commit, as on a re-run, it stops. `[skip ci]` in the message keeps the commit from starting other workflows.
5. `report html=$RUNNER_TEMP/site --store .` builds the report from every inspection on the branch. With `--sources github`, the report's source view loads files from GitHub at each inspected commit. The browser fetches them from `raw.githubusercontent.com`, so this works for public repositories. Use `--sources none` to leave the source view out. `--title` names the report after the repository.
6. The last step copies the report to the `gh-pages` branch with ggcp and pushes it.

## Permissions and the token

`permissions: {}` at the top removes every permission from the workflow's token, and each job asks only for what it needs. `analyze` gets `contents: read`. It runs your tests and dependencies, so it gets no secrets, and its checkout doesn't keep the token. `publish` gets `contents: write` to push to `repometry` and `gh-pages`.

Because the publish job's token can write to your repository, the job passes it only to the three steps that push, as `GH_TOKEN`. Both checkouts use `persist-credentials: false`, which keeps the token out of the checkout's Git configuration, so Repometry never sees it. ggcp gets the token in order to push, so the workflow pins its version.

Branch rules that cover `repometry` or `gh-pages` must let the workflow push.

## Concurrency

The publish job runs in the `repometry` concurrency group with `cancel-in-progress: false`. Only one publish job runs at a time, and a newer push doesn't stop a running one. Each job checks out the branch, adds one inspection and pushes. Two jobs at once would start from the same branch tip, and the second push would be rejected.

A concurrency group keeps at most one job waiting. When a push arrives while one publish job runs and another waits, GitHub cancels the waiting job, and its commit gets no inspection. Re-run the cancelled job within a day, while its artifact is kept.

## Pull requests from forks

The workflow runs only on pushes to the default branch. A pull request from a fork can't store inspections: GitHub gives its runs a read-only token and no secrets, so they can't push to `repometry`. They shouldn't either. The inspection would come from code that nobody has merged, and once it is on the branch it stays in the history. Don't give such runs a write token with `pull_request_target`, which runs in the context of your repository.

## Repair a store

`store check` reads every inspection in a store and reports missing or damaged objects. `--repair` restores them from another copy, such as the branch. To restore missing objects in your local `.repometry/` store from the branch:

```sh
git fetch origin repometry
npx repometry store check --repair --from git:origin/repometry
```

Where `repometry` is a local branch, as in the publish job's checkout, `--from git:repometry` reads the same data. To check a checkout of the branch, run `npx repometry store check --store .` in it. The branch has no `summary.json`, because the artifact leaves it out. Repometry doesn't need it to read the branch, and `store check` reports it as `stale`. [Checking a store](store.md#checking-a-store) lists every check.
