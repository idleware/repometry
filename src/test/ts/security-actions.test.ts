import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from './helpers/analysis.js';
import type { DataContract } from '../../main/ts/core/engine/plugin.js';
import { findingResult } from '../../main/ts/core/model/finding.js';
import type { Finding } from '../../main/ts/core/model/finding.js';
import { workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { actionsSecurity } from '../../main/ts/plugins/security/actions-security.js';

const sha = 'b4ffde65f46336ab88eb53be808477a3936bae11';

async function scan(text: string, path = '.github/workflows/ci.yml'): Promise<readonly Finding[]> {
  const file: unknown = { path, bytes: new TextEncoder().encode(text) };
  const result: unknown = await actionsSecurity.operations[0]!.execute({
    read<T>(_port: string, contract: DataContract<T>): T {
      if (!contract.accepts(file)) throw new Error('Unexpected input');
      return file;
    },
  });
  assert.ok(findingResult.accepts(result));
  for (const finding of result.findings) {
    assert.equal(finding.tool, 'actions-security');
    assert.equal(finding.category, 'infrastructure');
    assert.equal(finding.path, path);
    assert.match(finding.message, /^[A-Z][^\n]*\.$/);
  }
  return result.findings;
}

/** Findings as [rule, line, level] for every rule except the ones listed. */
async function rules(text: string, ignore: readonly string[] = ['persisted-credentials', 'missing-permissions']) {
  return (await scan(text)).filter(finding => !ignore.includes(finding.rule)).map(({ rule, line, level }) => [rule, line, level]);
}

test('the manifest declares a security plugin for workflow and action files with described infrastructure rules', async () => {
  assert.equal(actionsSecurity.id, 'actions-security');
  assert.deepEqual(actionsSecurity.kinds, ['security']);
  assert.deepEqual(actionsSecurity.claims?.globs, ['.github/workflows/*.yml', '.github/workflows/*.yaml', 'action.yml', 'action.yaml']);
  assert.deepEqual(actionsSecurity.produces, [{ contract: findingResult.id, persistence: 'report' }]);
  assert.deepEqual(actionsSecurity.rules?.map(rule => rule.id), [
    'unpinned-action', 'unpinned-first-party-action', 'script-injection', 'pull-request-target-checkout',
    'excessive-permissions', 'missing-permissions', 'persisted-credentials', 'secrets-inherit',
  ]);
  for (const rule of actionsSecurity.rules ?? []) {
    assert.equal(rule.category, 'infrastructure');
    assert.match(rule.description ?? '', /^[A-Z][^\n]*\.$/);
  }
  const workflow = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n';
  const bytes = new TextEncoder().encode(workflow);
  const report = await analyzeSnapshot({ excludedOutput: null, snapshot: workingSnapshot([
    { path: '.github/workflows/ci.yml', bytes }, { path: '.github/ci.yml', bytes }, { path: 'action.yml', bytes: new TextEncoder().encode(
      'name: Setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n') },
  ]) }, [actionsSecurity]);
  assert.deepEqual((report.findings ?? []).filter(finding => finding.tool === 'actions-security')
    .map(({ path, rule, line }) => [path, rule, line]), [
    ['.github/workflows/ci.yml', 'missing-permissions', 2],
    ['.github/workflows/ci.yml', 'persisted-credentials', 6],
    ['.github/workflows/ci.yml', 'unpinned-first-party-action', 6],
    ['action.yml', 'unpinned-first-party-action', 5],
  ]);
  assert.deepEqual(report.pluginData?.rules.find(item => item.plugin === 'actions-security')?.rules, actionsSecurity.rules);
});

test('unpinned-action flags third-party tags and branches, first-party refs are low, SHAs and local actions pass', async () => {
  const workflow = `name: CI
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: github/codeql-action/init@v3
      - uses: docker/build-push-action@v6
      - name: Publish
        uses: "softprops/action-gh-release@master" # moving branch
      - uses: dtolnay/rust-toolchain@${sha} # stable
      - uses: actions/setup-node@${sha.toUpperCase()}
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.20
  release:
    uses: octo-org/shared/.github/workflows/release.yml@v1
  deploy:
    uses: ./.github/workflows/deploy.yml
`;
  assert.deepEqual(await rules(workflow), [
    ['unpinned-first-party-action', 9, 'low'],
    ['unpinned-first-party-action', 12, 'low'],
    ['unpinned-action', 13, 'medium'],
    ['unpinned-action', 15, 'medium'],
    ['unpinned-action', 21, 'medium'],
  ]);
  const findings = await scan(workflow);
  assert.match(findings.find(finding => finding.line === 15)!.message, /softprops\/action-gh-release@master/);
  assert.match(findings.find(finding => finding.line === 21)!.message, /^Reusable workflow octo-org\/shared/);
});

test('script-injection flags attacker-controlled context expanded in run scripts at the line of the expression', async () => {
  const workflow = `on:
  issues:
    types: [opened]
  pull_request:
  issue_comment:
permissions: {}
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - name: Greet
        run: |
          echo "Thanks for the report"
          echo "Title: \${{ github.event.issue.title }}"
          if [ -n "\${{ github.event.comment.body }}" ]; then exit 1; fi
      - run: git push origin "\${{ github.head_ref }}"
      - run: >
          echo \${{ github.event.pull_request.head.ref }}
          \${{ github.event['pull_request']['body'] }}
      - run: "echo \\"\${{ github.event.commits[0].message }}\\""
      - run: echo \${{ format('{0}', github.event.head_commit.author.email) }} \${{ github.event.review.body || 'none' }}
      - run: echo \${{ GitHub.Event.Discussion.Title }}
`;
  assert.deepEqual(await rules(workflow), [
    ['script-injection', 14, 'high'],
    ['script-injection', 15, 'high'],
    ['script-injection', 16, 'high'],
    ['script-injection', 18, 'high'],
    ['script-injection', 19, 'high'],
    ['script-injection', 20, 'high'],
    ['script-injection', 21, 'high'],
    ['script-injection', 21, 'high'],
    ['script-injection', 22, 'high'],
  ]);
  const messages = (await scan(workflow)).map(finding => finding.message);
  assert.match(messages[0]!, /github\.event\.issue\.title/);
  assert.ok(messages.some(message => message.includes('github.event.commits.*.message')));
  assert.ok(messages.some(message => message.includes('github.event.pull_request.body')));
});

test('script-injection ignores inputs, env indirection, trusted context and boolean tests of untrusted context', async () => {
  const workflow = `on:
  workflow_dispatch:
    inputs:
      version:
        required: true
  issues:
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    env:
      TITLE: \${{ github.event.issue.title }}
    steps:
      - name: Use env indirection
        env:
          BODY: \${{ github.event.issue.body }}
          BRANCH: \${{ github.head_ref }}
        run: |
          echo "$TITLE"
          echo "$BODY" "$BRANCH"
      - run: ./release.sh "\${{ inputs.version }}" "\${{ github.event.inputs.version }}"
      - run: echo "\${{ github.sha }} \${{ github.ref_name }} \${{ github.event.pull_request.head.sha }} \${{ github.event.issue.number }}"
      - run: echo "\${{ contains(github.event.issue.title, '[skip]') }} \${{ github.head_ref == 'main' && 'yes' || 'no' }}"
      - run: echo "\${{ startsWith(github.event.issue.body, '/deploy') }} \${{ !github.event.issue.title }}"
      - run: echo "\${{ github.event.issue.title_html }} \${{ steps.meta.outputs.github.head_ref }}"
      - uses: actions/github-script@${sha}
        with:
          script: console.log(context.payload.issue.title)
`;
  assert.deepEqual(await rules(workflow), []);
});

test('pull-request-target-checkout flags untrusted checkouts in privileged workflows only', async () => {
  const target = `name: Preview
on:
  pull_request_target:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: actions/checkout@${sha}
        with: { repository: "\${{ github.event.pull_request.head.repo.full_name }}", persist-credentials: false }
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
          ref: refs/pull/\${{ github.event.pull_request.number }}/merge
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
          ref: \${{ github.event.pull_request.base.ref }}
`;
  assert.deepEqual(await rules(target), [
    ['pull-request-target-checkout', 15, 'high'],
    ['pull-request-target-checkout', 17, 'high'],
    ['pull-request-target-checkout', 21, 'high'],
  ]);
  assert.match((await scan(target))[0]!.message, /^This pull_request_target workflow checks out .*github\.event\.pull_request\.head\.sha/);

  const run = `on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions: read-all
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
          persist-credentials: false
`;
  assert.deepEqual(await rules(run), [['pull-request-target-checkout', 12, 'high']]);

  assert.deepEqual(await rules(target.replace('pull_request_target:', 'pull_request:')), []);
  assert.deepEqual(await rules(run.replace(/on:\n {2}workflow_run:\n.*\n.*\n/, 'on: [push, pull_request]\n')), []);
});

test('excessive-permissions flags write-all and missing-permissions flags workflows that set none', async () => {
  const writeAll = `on: push
permissions: write-all
jobs:
  build:
    permissions: 'write-all'
    runs-on: ubuntu-latest
    steps:
      - run: make
`;
  assert.deepEqual(await rules(writeAll, []), [['excessive-permissions', 2, 'medium'], ['excessive-permissions', 5, 'medium']]);
  assert.match((await scan(writeAll))[1]!.message, /^Job build sets permissions: write-all/);

  const missing = `on: push

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
`;
  assert.deepEqual(await rules(missing, []), [['missing-permissions', 3, 'low']]);
  assert.deepEqual(await rules(missing.replace('on: push\n', 'on: push\npermissions: {}\n'), []), []);
  assert.deepEqual(await rules(missing.replace('  build:\n', '  build:\n    permissions:\n      contents: read\n'), []), []);
  assert.deepEqual(await rules(missing.replace('on: push\n', 'on: push\npermissions: read-all\n'), []), []);
});

test('persisted-credentials flags checkout steps unless persist-credentials is false', async () => {
  const workflow = `on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@${sha}
    - uses: actions/checkout@${sha}
      with:
        fetch-depth: 0
        persist-credentials: true
    - uses: actions/checkout@${sha}
      with:
        persist-credentials: false
    - uses: actions/checkout@${sha}
      with: { fetch-depth: 0, persist-credentials: 'false' }
    - uses: actions/checkout@${sha}
      with:
        persist-credentials: \${{ inputs.persist }}
    - uses: actions/setup-node@${sha}
`;
  assert.deepEqual(await rules(workflow, []), [['persisted-credentials', 8, 'low'], ['persisted-credentials', 9, 'low']]);
});

test('secrets-inherit flags reusable workflow calls that pass every secret', async () => {
  const workflow = `on: push
permissions:
  contents: read
jobs:
  deploy:
    uses: octo-org/shared/.github/workflows/deploy.yml@${sha}
    secrets: inherit
  scoped:
    uses: ./.github/workflows/deploy.yml
    secrets:
      token: \${{ secrets.DEPLOY_TOKEN }}
`;
  assert.deepEqual(await rules(workflow, []), [['secrets-inherit', 7, 'low']]);
});

test('the reader handles composite actions, quoted keys, comments, CRLF, anchors and block scalar edges', async () => {
  const action = `name: Setup
description: Composite setup
inputs:
  token:
    description: Token
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
      with:
        persist-credentials: false
    - shell: bash
      run: echo "\${{ inputs.token }} \${{ github.event.issue.title }}"
`;
  assert.deepEqual((await scan(action, 'action.yml')).map(({ rule, line }) => [rule, line]), [
    ['unpinned-first-party-action', 9], ['script-injection', 13],
  ]);

  const workflow = [
    '# Release workflow',
    '---',
    '"on":',
    "  'pull_request_target': # comment",
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - &checkout',
    '        uses: actions/checkout@v4 # pinned by tag',
    '        with:',
    '          ref: ${{ github.head_ref }}',
    '      - name: Not a key in a script',
    '        run: |-',
    '          cat <<EOF',
    '          uses: evil/action@main',
    '          # ${{ github.event.issue.title }}',
    '',
    '          EOF',
    '      # A comment between steps',
    '      - run: echo done',
    '  again:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - *checkout',
    '',
  ].join('\r\n');
  assert.deepEqual((await scan(workflow)).map(({ rule, line }) => [rule, line]), [
    ['persisted-credentials', 12], ['unpinned-first-party-action', 12], ['pull-request-target-checkout', 14], ['script-injection', 19],
  ]);

  assert.deepEqual(await scan(''), []);
  assert.deepEqual(await scan('just: [unbalanced\nnot yaml at all: {\n- - -\n  "unterminated\n'), []);
});
