import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from '@repometry/core/internal/engine/execute.js';
import { plan } from '@repometry/core/internal/engine/plan.js';
import { findingResult, isFinding } from '@repometry/core/internal/model/finding.js';
import type { Finding } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import { exclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import { findingsPerRule, npmSupplyChain } from '../../main/ts/plugins/security/npm-supply-chain.js';

const tasks = plan({ plugins: [npmSupplyChain], select: ['npm-supply-chain/scan'], inputs: new Map([['file', sourceFile.id]]) });

async function outcome(path: string, text: string) {
  const file = { path, bytes: new TextEncoder().encode(text) };
  return (await execute(tasks, new Map([['file', { contract: sourceFile.id, value: file }]]))).get('npm-supply-chain/scan')!;
}

async function scan(path: string, text: string): Promise<readonly Finding[]> {
  const result = await outcome(path, text);
  assert.ok(result.state === 'completed', result.state === 'completed' ? '' : result.reason);
  const value = result.product.value;
  assert.ok(findingResult.accepts(value));
  const { findings, measurements } = value;
  assert.deepEqual(measurements, []);
  for (const finding of findings) {
    assert.ok(isFinding(finding));
    assert.equal(finding.tool, 'npm-supply-chain');
    assert.equal(finding.category, 'dependency');
    assert.equal(finding.path, path);
  }
  return findings;
}

/** The 1-based line of the first line containing the needle. */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex(line => line.includes(needle));
  assert.ok(index >= 0, `Fixture has no line with ${needle}`);
  return index + 1;
}

function rows(findings: readonly Finding[]): (string | number | undefined)[][] {
  return findings.map(({ rule, level, line, endLine }) => [rule, level, line, endLine]);
}

const riskyManifest = `{
  "name": "shop-frontend",
  "version": "1.4.0",
  "private": true,
  "scripts": {
    "preinstall": "node scripts/check-node-version.js",
    "postinstall": "node ./scripts/download-binaries.js --platform=$npm_config_platform",
    "prepare": "husky",
    "test": "node --test"
  },
  "dependencies": {
    "left-pad": "http://downloads.example.com/left-pad-1.3.0.tgz",
    "lodash": "^4.17.21",
    "internal-ui": "git+https://github.com/acme/internal-ui.git",
    "pinned-lib": "git+https://github.com/acme/pinned-lib.git#0123456789abcdef0123456789abcdef01234567",
    "legacy-proto": "git://github.com/acme/legacy-proto.git#v1.0.0",
    "shorthand": "acme/shorthand#main",
    "hosted": "github:acme/hosted#semver:^2.0.0",
    "floating": "*"
  },
  "devDependencies": {
    "eslint": "latest",
    "blank": "",
    "prettier": "~3.3.3",
    "vendored": "https://deploy:s3cr3t-token@files.example.com/vendored-1.0.0.tgz?signature=abc123",
    "archive": "https://codeload.github.com/acme/archive/tar.gz/89abcdef0123456789abcdef0123456789abcdef"
  },
  "optionalDependencies": {
    "aliased": "npm:fsevents@*"
  },
  "peerDependencies": {
    "react": "*"
  }
}
`;

test('package.json: URL, git and tarball dependencies, unbounded ranges and install scripts are reported on their lines', async () => {
  const findings = await scan('apps/shop/package.json', riskyManifest);
  const at = (needle: string) => lineOf(riskyManifest, needle);
  assert.deepEqual(rows(findings), [
    ['install-script', 'medium', at('"preinstall"'), at('"preinstall"')],
    ['install-script', 'medium', at('"postinstall"'), at('"postinstall"')],
    ['dependency-from-url', 'high', at('"left-pad"'), at('"left-pad"')],
    ['dependency-from-url', 'high', at('"internal-ui"'), at('"internal-ui"')],
    ['dependency-from-url', 'low', at('"pinned-lib"'), at('"pinned-lib"')],
    ['dependency-from-url', 'high', at('"legacy-proto"'), at('"legacy-proto"')],
    ['dependency-from-url', 'high', at('"shorthand"'), at('"shorthand"')],
    ['dependency-from-url', 'high', at('"hosted"'), at('"hosted"')],
    ['dependency-unbounded', 'low', at('"floating"'), at('"floating"')],
    ['dependency-unbounded', 'low', at('"eslint"'), at('"eslint"')],
    ['dependency-unbounded', 'low', at('"blank"'), at('"blank"')],
    ['dependency-from-url', 'high', at('"vendored"'), at('"vendored"')],
    ['dependency-from-url', 'low', at('"archive"'), at('"archive"')],
    ['dependency-unbounded', 'low', at('"aliased"'), at('"aliased"')],
  ]);
  const message = (needle: string) => findings.find(finding => finding.line === at(needle))?.message ?? '';
  assert.equal(message('"left-pad"'),
    'Dependency left-pad is downloaded over plain HTTP from http://downloads.example.com/left-pad-1.3.0.tgz.');
  assert.equal(message('"internal-ui"'),
    'Dependency internal-ui follows git source git+https://github.com/acme/internal-ui.git without a pinned commit.');
  assert.match(message('"pinned-lib"'), /^Dependency pinned-lib bypasses the registry but is pinned to commit 0123456789ab of /);
  assert.match(message('"legacy-proto"'), /unencrypted git:\/\//);
  assert.equal(message('"eslint"'), 'Dependency eslint accepts any version ("latest").');
  assert.equal(message('"blank"'), 'Dependency blank accepts any version (empty range).');
  assert.match(message('"postinstall"'), /^Package shop-frontend runs a postinstall script on every install: "node \.\/scripts\/download-binaries\.js/);
  // Credentials and query strings never reach the report.
  assert.equal(message('"vendored"'),
    'Dependency vendored follows remote tarball https://files.example.com/vendored-1.0.0.tgz without a pinned commit.');
  assert.ok(findings.every(finding => !/s3cr3t|signature/.test(finding.message)));
  assert.ok(findings.every(finding => finding.line !== at('"react"') && finding.line !== at('"prepare"')));
});

test('package.json: registry ranges, local specs, aliases and non-install scripts are safe', async () => {
  const manifest = `{
  "name": "@acme/safe",
  "version": "2.0.0",
  "scripts": { "prepare": "tsc -p .", "test": "node --test", "build": "tsc", "prepublishOnly": "npm test", "postinstall": "" },
  "dependencies": {
    "lodash": "^4.17.21",
    "react": ">=18.2.0 <20",
    "semver": "7.6.3",
    "next": "canary",
    "local": "file:../local",
    "linked": "link:../linked",
    "sibling": "workspace:^",
    "vendored": "./vendor/pkg",
    "home": "~/src/pkg",
    "string-width-cjs": "npm:string-width@^4.2.0"
  },
  "devDependencies": { "typescript": "~5.6.3", "@types/node": "24.x" },
  "peerDependencies": { "react-dom": "*" },
  "engines": { "node": "*" }
}
`;
  assert.deepEqual(await scan('package.json', manifest), []);
});

const lockfile = `{
  "name": "shop",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "shop",
      "version": "1.0.0",
      "workspaces": ["packages/*"],
      "dependencies": {
        "lodash": "^4.17.21"
      }
    },
    "node_modules/lodash": {
      "version": "4.17.21",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      "integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
      "license": "MIT"
    },
    "node_modules/js-tokens": {
      "version": "4.0.0",
      "resolved": "https://registry.yarnpkg.com/js-tokens/-/js-tokens-4.0.0.tgz",
      "integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ=="
    },
    "node_modules/insecure": {
      "version": "1.0.0",
      "resolved": "http://registry.npmjs.org/insecure/-/insecure-1.0.0.tgz",
      "integrity": "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    },
    "node_modules/@acme/private": {
      "version": "2.0.0",
      "resolved": "https://npm.corp.example/@acme/private/-/private-2.0.0.tgz",
      "integrity": "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=="
    },
    "node_modules/no-hash": {
      "version": "0.1.0",
      "resolved": "https://registry.npmjs.org/no-hash/-/no-hash-0.1.0.tgz",
      "dev": true
    },
    "node_modules/express/node_modules/debug": {
      "version": "2.6.9",
      "resolved": "http://mirror.example.net/debug/-/debug-2.6.9.tgz",
      "integrity": "sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=="
    },
    "node_modules/git-dep": {
      "version": "1.0.0",
      "resolved": "git+ssh://git@github.com/acme/git-dep.git#0123456789abcdef0123456789abcdef01234567",
      "license": "MIT"
    },
    "node_modules/local-tarball": {
      "version": "1.0.0",
      "resolved": "file:vendor/local-tarball-1.0.0.tgz",
      "integrity": "sha512-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=="
    },
    "node_modules/workspace-lib": {
      "resolved": "packages/lib",
      "link": true
    },
    "packages/lib": {
      "name": "workspace-lib",
      "version": "1.0.0"
    }
  }
}
`;

test('package-lock.json: insecure, foreign and integrity-less entries are reported at the resolved line or entry span', async () => {
  const at = (needle: string) => lineOf(lockfile, needle);
  for (const path of ['package-lock.json', 'services/api/npm-shrinkwrap.json']) {
    const findings = await scan(path, lockfile);
    assert.deepEqual(rows(findings), [
      ['lockfile-insecure-registry', 'high', at('http://registry.npmjs.org/insecure'), at('http://registry.npmjs.org/insecure')],
      ['lockfile-foreign-host', 'medium', at('npm.corp.example'), at('npm.corp.example')],
      ['lockfile-missing-integrity', 'medium', at('"node_modules/no-hash"'), at('"dev": true') + 1],
      ['lockfile-insecure-registry', 'high', at('mirror.example.net'), at('mirror.example.net')],
      ['lockfile-foreign-host', 'medium', at('mirror.example.net'), at('mirror.example.net')],
      ['lockfile-foreign-host', 'medium', at('git+ssh://'), at('git+ssh://')],
    ]);
    assert.deepEqual(findings.map(finding => finding.message), [
      'Package insecure is downloaded over unencrypted http:// from registry.npmjs.org.',
      'Package @acme/private resolves from npm.corp.example instead of the npm registry.',
      'Package no-hash resolves from registry.npmjs.org without an integrity hash.',
      'Package debug is downloaded over unencrypted http:// from mirror.example.net.',
      'Package debug resolves from mirror.example.net instead of the npm registry.',
      'Package git-dep resolves from github.com instead of the npm registry.',
    ]);
  }
});

test('package-lock.json: a clean registry lockfile and a v1 lockfile without a packages map have no findings', async () => {
  const clean = JSON.stringify({ name: 'clean', lockfileVersion: 2, requires: true, packages: {
    '': { name: 'clean', dependencies: { lodash: '^4.17.21' } },
    'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==' },
  }, dependencies: { lodash: { version: '4.17.21', resolved: 'http://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }, null, 2);
  assert.deepEqual(await scan('package-lock.json', clean), []);
  const legacy = JSON.stringify({ name: 'legacy', lockfileVersion: 1, dependencies: {
    lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', integrity: 'sha512-x' } } }, null, 2);
  assert.deepEqual(await scan('package-lock.json', legacy), []);
});

test('package-lock.json: escaped keys, minified JSON and a BOM keep line numbers right', async () => {
  const minified = '﻿{"lockfileVersion":3,"packages":{"":{},"node_modules/q\\u0075ote\\"d":{"resolved":"http://x.example/q.tgz"}}}';
  const findings = await scan('package-lock.json', minified);
  assert.deepEqual(rows(findings), [
    ['lockfile-insecure-registry', 'high', 1, 1], ['lockfile-foreign-host', 'medium', 1, 1], ['lockfile-missing-integrity', 'medium', 1, 1],
  ]);
  assert.match(findings[0]!.message, /^Package quote"d /);
});

test('package-lock.json: a rule with more than the limit lists the first hits and one summary with the total', async () => {
  const packages: Record<string, unknown> = { '': { name: 'big' } };
  for (let index = 0; index < 25; index++) {
    packages[`node_modules/private-${index}`] = { version: '1.0.0', resolved: `https://npm.corp.example/private-${index}/-/private-${index}-1.0.0.tgz`,
      integrity: 'sha512-x' };
  }
  for (let index = 0; index < 3; index++) {
    packages[`node_modules/bare-${index}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/bare-${index}/-/bare-${index}-1.0.0.tgz` };
  }
  const text = JSON.stringify({ lockfileVersion: 3, packages }, null, 2);
  const findings = await scan('package-lock.json', text);
  const foreign = findings.filter(finding => finding.rule === 'lockfile-foreign-host');
  assert.equal(findingsPerRule, 20);
  assert.equal(foreign.length, findingsPerRule + 1);
  assert.deepEqual(foreign.slice(0, findingsPerRule).map(finding => finding.line),
    Array.from({ length: findingsPerRule }, (_, index) => lineOf(text, `private-${index}/-/`)));
  const summary = foreign.at(-1)!;
  assert.equal(summary.line, undefined);
  assert.equal(summary.level, 'medium');
  assert.equal(summary.message, 'package-lock.json has 25 lockfile-foreign-host findings; only the first 20 are listed.');
  assert.equal(findings.filter(finding => finding.rule === 'lockfile-missing-integrity').length, 3);
  assert.equal(findings.length, findingsPerRule + 1 + 3);
});

const yarnClassic = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.12.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#dcfc826beef65e75c50e21d3837d7d95798dd658"
  integrity sha512-HV1Cm0Q3ZrpCR93tkWOYiuYIgLxZXZFVG2VgK+MBWjUqZTundupbfx2aXarXuw5Ko5aMcjtJgbSs4vUGBS5v6g==
  dependencies:
    "@babel/highlight" "^7.12.13"

insecure@^1.0.0:
  version "1.0.0"
  resolved "http://registry.yarnpkg.com/insecure/-/insecure-1.0.0.tgz#4f1b1d7b2f5d1c4c8e9a0b6c3d2e1f0a9b8c7d6e"
  integrity sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==

lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c"
  integrity sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==

"@acme/private@^2.0.0":
  version "2.0.0"
  resolved "https://npm.corp.example/@acme/private/-/private-2.0.0.tgz#0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"
  integrity sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==
`;

test('yarn.lock v1: http and foreign-host resolved URLs are reported, registry ones are not', async () => {
  const findings = await scan('yarn.lock', yarnClassic);
  const at = (needle: string) => lineOf(yarnClassic, needle);
  assert.deepEqual(rows(findings), [
    ['lockfile-insecure-registry', 'high', at('http://registry.yarnpkg.com'), at('http://registry.yarnpkg.com')],
    ['lockfile-foreign-host', 'medium', at('npm.corp.example'), at('npm.corp.example')],
  ]);
  assert.deepEqual(findings.map(finding => finding.message), [
    'Package insecure is downloaded over unencrypted http:// from registry.yarnpkg.com.',
    'Package @acme/private resolves from npm.corp.example instead of the npm registry.',
  ]);
});

const yarnBerry = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    legacy: "http://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz"
    lodash: "npm:^4.17.21"
    tool: "https://downloads.example.com/tool-1.0.0.tgz"
  languageName: unknown
  linkType: soft

"legacy@http://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz":
  version: 1.0.0
  resolution: "legacy@http://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz"
  checksum: 10c0/0123456789abcdef
  languageName: node
  linkType: hard

"lodash@npm:^4.17.20, lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/d8cbea072bb08655bb4c989da418994b073a608dffa608b09ac04b43a791b12aeae7cd7ad919aa4c925f33b48490b5cfe6c1f71d827956071dae2e7bb3a6b74c
  languageName: node
  linkType: hard

"tool@https://downloads.example.com/tool-1.0.0.tgz":
  version: 1.0.0
  resolution: "tool@https://downloads.example.com/tool-1.0.0.tgz"
  checksum: 10c0/fedcba9876543210
  languageName: node
  linkType: hard
`;

test('yarn.lock berry: URL resolutions are checked while npm: and workspace: resolutions and dependency specs are not', async () => {
  const findings = await scan('web/yarn.lock', yarnBerry);
  const at = (needle: string) => lineOf(yarnBerry, needle);
  assert.deepEqual(rows(findings), [
    ['lockfile-insecure-registry', 'high', at('resolution: "legacy@'), at('resolution: "legacy@')],
    ['lockfile-foreign-host', 'medium', at('resolution: "tool@'), at('resolution: "tool@')],
  ]);
  assert.deepEqual(findings.map(finding => finding.message), [
    'Package legacy is downloaded over unencrypted http:// from registry.npmjs.org.',
    'Package tool resolves from downloads.example.com instead of the npm registry.',
  ]);
});

const pnpmV9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
      tool:
        specifier: http://downloads.example.com/tool-1.0.0.tgz
        version: http://downloads.example.com/tool-1.0.0.tgz

packages:

  '@babel/code-frame@7.24.7':
    resolution: {integrity: sha512-BcYH1CVJBO9tvyIZ2jVeXgSIMvGZ2FDRvDdOIVQyuklNKSsx+eppDEBq/g47Ayw+RqNFE+URvOShmf+f/qwAlA==}
    engines: {node: '>=6.9.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz}

  tool@http://downloads.example.com/tool-1.0.0.tgz:
    resolution: {tarball: http://downloads.example.com/tool-1.0.0.tgz}
    version: 1.0.0

  insecure@1.0.0:
    resolution:
      integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
      tarball: http://registry.npmjs.org/insecure/-/insecure-1.0.0.tgz
    engines: {node: '>=18'}

  '@acme/private@2.0.0(react@18.3.1)':
    resolution: {integrity: sha512-BBBB, registry: https://npm.corp.example/, tarball: https://npm.corp.example/@acme/private/-/private-2.0.0.tgz}

  git-dep@https://codeload.github.com/acme/git-dep/tar.gz/0123456789abcdef0123456789abcdef01234567:
    resolution: {commit: 0123456789abcdef0123456789abcdef01234567, repo: git+ssh://git@github.com/acme/git-dep.git, type: git}
    version: 1.0.0

snapshots:

  lodash@4.17.21: {}
`;

test('pnpm-lock.yaml v9: inline and block resolutions are checked once per entry and rule', async () => {
  const findings = await scan('pnpm-lock.yaml', pnpmV9);
  const at = (needle: string) => lineOf(pnpmV9, needle);
  assert.deepEqual(rows(findings), [
    ['lockfile-insecure-registry', 'high', at('{tarball: http://downloads'), at('{tarball: http://downloads')],
    ['lockfile-foreign-host', 'medium', at('{tarball: http://downloads'), at('{tarball: http://downloads')],
    ['lockfile-insecure-registry', 'high', at('tarball: http://registry.npmjs.org/insecure'), at('tarball: http://registry.npmjs.org/insecure')],
    ['lockfile-foreign-host', 'medium', at('registry: https://npm.corp.example/'), at('registry: https://npm.corp.example/')],
    ['lockfile-foreign-host', 'medium', at('repo: git+ssh://'), at('repo: git+ssh://')],
  ]);
  assert.deepEqual(findings.map(finding => finding.message), [
    'Package tool is downloaded over unencrypted http:// from downloads.example.com.',
    'Package tool resolves from downloads.example.com instead of the npm registry.',
    'Package insecure is downloaded over unencrypted http:// from registry.npmjs.org.',
    'Package @acme/private resolves from npm.corp.example instead of the npm registry.',
    'Package git-dep resolves from github.com instead of the npm registry.',
  ]);
});

test('pnpm-lock.yaml v5: path keys and a later name field name the package', async () => {
  const text = `lockfileVersion: 5.4

specifiers:
  lodash: ^4.17.21
  repo: github:acme/repo#0123456789abcdef0123456789abcdef01234567

dependencies:
  lodash: 4.17.21
  repo: github.com/acme/repo/0123456789abcdef0123456789abcdef01234567

packages:

  /lodash/4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}
    dev: false

  /@scope/insecure/1.0.0_react@18.3.1:
    resolution: {integrity: sha512-AAAA, tarball: http://registry.npmjs.org/@scope/insecure/-/insecure-1.0.0.tgz}
    dev: false

  github.com/acme/repo/0123456789abcdef0123456789abcdef01234567:
    resolution: {tarball: https://codeload.github.com/acme/repo/tar.gz/0123456789abcdef0123456789abcdef01234567}
    name: repo
    version: 1.0.0
    dev: false
`;
  const findings = await scan('pnpm-lock.yaml', text);
  assert.deepEqual(rows(findings), [
    ['lockfile-insecure-registry', 'high', lineOf(text, 'http://registry'), lineOf(text, 'http://registry')],
    ['lockfile-foreign-host', 'medium', lineOf(text, 'codeload'), lineOf(text, 'codeload')],
  ]);
  assert.deepEqual(findings.map(finding => finding.message), [
    'Package @scope/insecure is downloaded over unencrypted http:// from registry.npmjs.org.',
    'Package repo resolves from codeload.github.com instead of the npm registry.',
  ]);
});

test('files under node_modules and unrelated names are skipped, and invalid JSON fails the operation', async () => {
  const manifest = '{ "name": "dep", "scripts": { "postinstall": "node evil.js" }, "dependencies": { "x": "*" } }';
  assert.deepEqual(await scan('node_modules/dep/package.json', manifest), []);
  assert.deepEqual(await scan('packages/a/node_modules/dep/package.json', manifest), []);
  assert.deepEqual(await scan('node_modules/.package-lock.json', lockfile), []);
  assert.deepEqual(await scan('docs/package.json.md', manifest), []);
  assert.equal((await scan('tools/package.json', manifest)).length, 2);
  const broken = await outcome('package-lock.json', '{\n<<<<<<< HEAD\n  "lockfileVersion": 3\n}');
  assert.equal(broken.state, 'failed');
  assert.match(broken.state === 'failed' ? broken.reason : '', /^package-lock\.json is not valid JSON/);
});

test('the manifest claims npm manifests and lockfiles at any depth and declares dependency rules', () => {
  assert.equal(npmSupplyChain.id, 'npm-supply-chain');
  assert.deepEqual(npmSupplyChain.kinds, ['security']);
  assert.deepEqual(npmSupplyChain.produces, [{ contract: findingResult.id, persistence: 'report' }]);
  assert.deepEqual(npmSupplyChain.rules?.map(rule => rule.id), ['dependency-from-url', 'dependency-unbounded', 'install-script',
    'lockfile-insecure-registry', 'lockfile-foreign-host', 'lockfile-missing-integrity']);
  assert.ok(npmSupplyChain.rules?.every(rule => rule.category === 'dependency' && /^[A-Z].*\.$/.test(rule.description ?? '')));
  const claimed = exclusionMatcher(npmSupplyChain.claims?.globs ?? []);
  for (const path of ['package.json', 'apps/web/package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
    'packages/ui/yarn.lock', 'pnpm-lock.yaml']) assert.ok(claimed(path), path);
  for (const path of ['src/index.ts', 'package.json5', 'yarn.lock.bak', 'pnpm-workspace.yaml']) assert.ok(!claimed(path), path);
});
