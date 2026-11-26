# Publish metrics from CI

This guide sets up Repometry in GitHub Actions. On each push to the default branch, it analyses the commit with your test coverage, saves the inspection to a `repometry` branch in your repository, and publishes the HTML report and badges to GitHub Pages. On each pull request, it reviews the change and posts the result as one comment.

Repometry does this for itself with one workflow file, [`repometry.yaml`](../.github/workflows/repometry.yaml), which its [CI workflow](../.github/workflows/ci.yaml) calls after the build. The file is the whole setup, and you copy it into your project.

## Why a separate branch

The `repometry` branch shares no history with your code. It holds only the store: a manifest, a report file for each inspected commit, and the objects those files refer to. [Store format](store.md) describes them. Each inspection is a commit on this branch, so your default branch and its history stay as they are.

The data is still part of your repository. It is versioned, it has the repository's access rules, and anyone who can fetch the repository can open the report without a checkout of the branch:

```sh
git fetch origin repometry
npx repometry view --store git:origin/repometry
```

## Set up

1. Copy [`repometry.yaml`](../.github/workflows/repometry.yaml) to `.github/workflows/` in your project, and change what is specific to Repometry's own build:
   - Run a release instead of the build: replace `node target/main/ts/cli/main.js` with `npx --yes repometry@0.11.0`, and remove the `npm ci` steps. Repometry needs Node.js 24 or later.
   - The `build` artifact holds Repometry's build and coverage. Download the artifact with your coverage instead, and change the `--import` paths to match. For Go and Python coverage, see [Go and Python analysis](native-languages.md#importing-coverage).
   - The Git author comes from repository variables. Set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` in your repository, or write the values in the file.
2. In your CI workflow, upload the coverage from the job that runs your tests, and call the file after it, as below.
3. In your repository's settings, under Pages, set the source to GitHub Actions.
4. Push. The first push to the default branch creates the `repometry` branch and deploys the report.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions: {}

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }} # a pull request's own head, which the review compares
          persist-credentials: false
      - run: npm ci && npm test # Your tests. They write coverage/lcov.info.
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: coverage
          path: coverage/lcov.info
          retention-days: 1

  repometry:
    needs: test
    permissions:
      contents: write # the repometry branch, on a push
      pages: write # the report on GitHub Pages, on a push
      id-token: write # the same
      pull-requests: write # the review comment, on a pull request
    uses: ./.github/workflows/repometry.yaml
```

The report is then at `https://OWNER.github.io/REPO/`. The badges `coverage.svg`, `maintainability.svg` and `security.svg` are next to it:

```md
[![Coverage](https://OWNER.github.io/REPO/coverage.svg)](https://OWNER.github.io/REPO/)
```

A report shows everything the store holds, and a GitHub Pages site can be public even when its repository is private. Keep security, dependency, secret and infrastructure scanner results out of this workflow, and import them into a local store instead. For a private repository, see [Private repositories](#private-repositories).

The file has three jobs. `review` runs on a pull request. `history` and then `pages` run on a push. Your CI workflow decides which pushes those are: call the file only for the default branch.

## On a push

`history` fetches the `repometry` branch, analyses the commits the catch-up finds, then the pushed commit with your coverage, and builds the report from the whole branch. It then pushes the new inspections to the branch and uploads the report, which `pages` deploys to GitHub Pages.

The full history is for churn: how many first-parent commits touched each file in the 90 days up to the inspected commit. Nothing else in an inspection needs earlier commits.

`analyze` exits with 0 when the inspection is complete, 2 when it is partial, for example when a file can't be parsed, and 1 when it can't run; [Exit codes](cli.md#exit-codes) lists every command's codes. A missing or failing `go` or `python3` doesn't make it partial: that language's files count as not analysed, and the report's Profile and `repometry plugins` say why. The job saves a partial inspection, marked as partial, and its log says what is missing. Any other failure fails the run, and nothing is saved.

### The queue and the catch-up

Only one `history` job runs at a time, so two jobs never push from the same branch tip. The others wait in a queue, up to 100 of them, in the order they arrive, and none is cancelled. Your CI workflow must not cancel runs on the default branch either, or their commits wait for the catch-up.

Some commits still get no run of their own. Each run's catch-up analyses the first-parent commits before it that the branch doesn't hold, up to 20 of them:

- a commit whose run failed, for example because a test failed;
- a commit whose run was cancelled, for example by a concurrency group that cancels older runs;
- a commit pushed with `[skip ci]`, such as a release commit;
- the commits before you set up the workflow, on the first run.

The catch-up stops before the root commit, which only its own run inspects. These inspections have no coverage, because your tests ran on another commit. The report shows their coverage as missing, not as zero. When a commit's own run comes after another run caught it up, its inspection with coverage replaces the caught-up one. A caught-up inspection never replaces one that's already on the branch.

### The report

GitHub Pages serves the report from the deployment, so no branch holds it, and each deployment replaces the one before. Runs take turns, so each report holds every inspection saved before it.

## Permissions and the token

`permissions: {}` at the top removes every permission from the workflow's token, and each job asks only for what it needs. Your test job gets `contents: read`. `review` gets `pull-requests: write` for the comment, `history` gets `contents: write` for the branch, and `pages` gets `pages: write` and `id-token: write` to deploy. Your CI workflow grants them to the call.

Your tests and their dependencies run in your test job, with a read-only token. Repometry runs in `review` and `history`, and `pages` runs only GitHub's deploy action. The token reaches only the steps that fetch, push and comment, and every checkout uses `persist-credentials: false`, so the token is never written to a Git configuration on disk.

Branch rules that cover `repometry` must let the workflow push. The `github-pages` environment that GitHub creates lets the default branch deploy.

## Forks

`history` runs only on pushes. A pull request from a fork can't store inspections: GitHub gives its runs a read-only token, so they can't push to `repometry`. They shouldn't either. The inspection would come from code that nobody has merged, and once it is on the branch it stays in the history. Don't give such runs a write token with `pull_request_target`, which runs in the context of your repository. Their reviews still appear on the pull request, as annotations and in the run summary, but not as a comment: GitHub gives their runs a token that can't comment.

## Pull requests

`repometry review` shows what a pull request does to the code it changes, and nothing else. It analyses the merge base and the pull request's head, compares them, and keeps the issues on the changed lines:

| Group | What it holds | Fails the check |
| --- | --- | --- |
| New | issues on the changed lines that the base didn't have | yes |
| Worsened | issues the base had, whose value went up, such as a function's complexity going from 17 to 19 | yes |
| Improved | issues the change removed, or whose value went down | no |
| Touched | issues the base had on these lines, unchanged | no |

An issue keeps its identity through renames and moves within its file. A duplicate shows once, on the copy the change touched. Whole-file issues, such as file complexity, are new when the change crosses the limit and worsened when the file grows past it.

The review compares findings only: it doesn't count churn, and it skips scanner imports such as SARIF, ESLint or OSV files, which describe one checkout and can't be compared. The check also measures coverage of the changed lines, and fails below 80% once at least 20 changed lines are measured. It doesn't show repository totals or grades. Set `maxNewIssues`, `minCoverage` and `minLines` in `repometry.config.json` to change the limits. The command exits with 0 when the check passes, 3 when it fails, 2 when a measurement it needs is missing on the head, and 1 when it can't run ([Exit codes](cli.md#exit-codes)). The review job's result is the check.

The review is shown in three places: annotations on the pull request's diff, the run summary, and one comment on the pull request that is updated on every push. A pull request from a fork gets no comment. It's never stored, on the `repometry` branch or anywhere else.

The review compares the pull request's own head, the commit its diff shows, with the merge base, so the test job checks out that head too, and the coverage describes the same lines. If you feed this job's coverage to your own coverage gate, so the tests run once, the gate measures that head, not its merge with the base branch, which a job on the default `pull_request` checkout would measure. Run the gate in a job of its own when that difference matters.

When your tests fail, `review` doesn't run, and an earlier comment stays as it was. It names the commit it reviewed.

## Private repositories

A GitHub Pages site can be public even when its repository is private. To keep the report off GitHub Pages, remove the `pages` job, and the `report` line and the last step of `history`. The inspections are still saved to the `repometry` branch, which has the repository's access rules, and you can open the report from it:

```sh
git fetch origin repometry
npx repometry view --store git:origin/repometry
```

For a private repository, also change `--sources github` to `--sources none`. The report then leaves out the source view, because a browser can't load private files from GitHub.

## Repair a store

`store check` reads every inspection in a store and reports missing or damaged objects. `--repair` restores them from another copy, such as the branch. To restore missing objects in your local `.repometry/` store from the branch:

```sh
git fetch origin repometry
npx repometry store check --repair --from git:origin/repometry
```

Where `repometry` is a local branch, `--from git:repometry` reads the same data. To check a checkout of the branch, run `npx repometry store check --store .` in it. The branch has no `summary.json`, because the workflow leaves it out. Repometry doesn't need it to read the branch, and `store check` reports it as `stale`. [Checking a store](store.md#checking-a-store) lists every check.
