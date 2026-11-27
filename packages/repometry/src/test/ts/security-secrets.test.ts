import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from '@repometry/core/internal/engine/execute.js';
import { manifestProducts } from '@repometry/core/internal/engine/manifest.js';
import { plan } from '@repometry/core/internal/engine/plan.js';
import type { DataContract, InspectionInputs } from '@repometry/core/internal/engine/plugin.js';
import { findingResult } from '@repometry/core/internal/model/finding.js';
import type { Finding } from '@repometry/core/internal/model/finding.js';
import { sourceFile } from '@repometry/core/internal/model/snapshot.js';
import { exclusionMatcher } from '@repometry/core/internal/profile/exclusions.js';
import { ignoreMarker, maxScannedBytes, secrets } from '../../main/ts/plugins/security/secrets.js';

const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const lower = upper.toLowerCase();
const digits = '0123456789';
const alnum = upper + lower + digits;
const hex = '0123456789abcdef';

/** Deterministic pseudo-random text, so this file holds no literal token for scanners or push protection to catch. */
function fake(alphabet: string, length: number, seed: number): string {
  let state = seed >>> 0;
  let text = '';
  while (text.length < length) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    text += alphabet[((mixed ^ (mixed >>> 14)) >>> 0) % alphabet.length];
  }
  return text;
}

function scan(path: string, content: string | Uint8Array): Finding[] {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const inputs: InspectionInputs = {
    read<T>(port: string, contract: DataContract<T>): T {
      assert.equal(port, 'source');
      const value: unknown = { path, bytes };
      assert.ok(contract.accepts(value));
      return value;
    },
  };
  const result = secrets.operations[0]!.execute(inputs);
  assert.ok(findingResult.accepts(result));
  assert.deepEqual(result.measurements, []);
  return [...result.findings];
}

function summary(findings: readonly Finding[]): (readonly [string, string, number | undefined])[] {
  return findings.map(({ rule, level, line }) => [rule, level, line]);
}

const jwtPart = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const pemHeader = (label: string): string => `-----BEGIN ${label}-----`;
const pemFooter = (label: string): string => `-----END ${label}-----`;
const keyBody = Array.from({ length: 4 }, (_, index) => fake(alnum + '+/', 64, 18 + index));
const pem = (label: string, body: readonly string[] = keyBody): string => [pemHeader(label), ...body, pemFooter(label)].join('\n');

const awsKeyId = 'AKIA' + fake(upper + '234567', 16, 1);
const awsSessionKeyId = 'ASIA' + fake(upper + '234567', 16, 2);
const awsSecret = fake(alnum + '+/', 40, 3);
const githubToken = 'ghp_' + fake(alnum, 36, 4);
const githubPat = 'github_pat_' + fake(alnum, 22, 5) + '_' + fake(alnum, 59, 6);
const gitlabToken = 'glpat-' + fake(alnum + '_-', 20, 7);
const slackToken = ['xoxb', fake(digits, 12, 8), fake(digits, 13, 9), fake(alnum, 24, 10)].join('-');
const slackWebhook = `https://hooks.slack.com/services/T${fake(upper + digits, 8, 11)}/B${fake(upper + digits, 10, 12)}/${fake(alnum, 24, 13)}`;
const stripeKey = 'sk_live_' + fake(alnum, 24, 14);
const stripeRestricted = 'rk_live_' + fake(alnum, 32, 15);
const googleKey = 'AIza' + fake(alnum + '_-', 35, 16);
const npmToken = 'npm_' + fake(alnum, 36, 17);
const jwt = [jwtPart({ alg: 'HS256', typ: 'JWT' }), jwtPart({ sub: '1234567890', iat: 1700000000 }), fake(alnum + '-_', 43, 22)].join('.');
const password = fake(alnum + '!#%&', 20, 23);
const apiKey = fake(alnum, 32, 24);
const clientSecret = fake(alnum, 28, 25);
const authToken = fake(alnum + '-_', 32, 26);
const hexSecret = fake(hex, 32, 27);
const registryToken = fake(alnum, 36, 52);
const pypiToken = 'pypi-' + fake(alnum + '-_', 60, 53);
const gitPassword = fake(alnum, 40, 51);

type Expected = readonly (readonly [rule: string, level: Finding['level'], line: number])[];

interface Hit {
  readonly name: string;
  readonly path?: string;
  readonly text: string;
  /** The value that must never appear in a message. */
  readonly secret: string;
  readonly expected: Expected;
  readonly message?: string;
}

const hits: readonly Hit[] = [
  { name: 'AWS access key ID', text: `const credentials = { accessKeyId: '${awsKeyId}' };`, secret: awsKeyId,
    expected: [['aws-access-key-id', 'high', 1]], message: 'Hard-coded AWS access key ID' },
  { name: 'AWS temporary access key ID', text: `AWS_ACCESS_KEY_ID=${awsSessionKeyId}`, secret: awsSessionKeyId,
    expected: [['aws-access-key-id', 'high', 1]] },
  { name: 'AWS secret access key in a credentials file', path: 'deploy/credentials', text: `[default]\naws_secret_access_key = ${awsSecret}`,
    secret: awsSecret, expected: [['aws-secret-access-key', 'high', 2]] },
  { name: 'AWS secret access key in JSON wins over the generic rule', text: `{"SecretAccessKey": "${awsSecret}"}`, secret: awsSecret,
    expected: [['aws-secret-access-key', 'high', 1]] },
  { name: 'GitHub classic token', text: `GITHUB_TOKEN=${githubToken}`, secret: githubToken, expected: [['github-token', 'high', 1]],
    message: 'Hard-coded GitHub token' },
  { name: 'GitHub fine-grained token wins over the generic rule', text: `const token = "${githubPat}";`, secret: githubPat,
    expected: [['github-token', 'high', 1]] },
  { name: 'GitLab token in a clone URL', text: `git clone https://oauth2:${gitlabToken}@gitlab.com/group/project.git`, secret: gitlabToken,
    expected: [['gitlab-token', 'high', 1]] },
  { name: 'Slack bot token', path: 'ci.yml', text: `env:\n  SLACK_BOT_TOKEN: ${slackToken}`, secret: slackToken,
    expected: [['slack-token', 'high', 2]] },
  { name: 'Slack webhook URL', text: `webhook_url = "${slackWebhook}"`, secret: slackWebhook, expected: [['slack-webhook', 'high', 1]] },
  { name: 'Stripe live secret key wins over the generic rule', text: `stripe.api_key = '${stripeKey}'`, secret: stripeKey,
    expected: [['stripe-secret-key', 'high', 1]] },
  { name: 'Stripe live restricted key', text: `STRIPE_KEY=${stripeRestricted}`, secret: stripeRestricted,
    expected: [['stripe-secret-key', 'high', 1]] },
  { name: 'Google API key', path: 'index.html', text: `<meta name="maps" content="${googleKey}">`, secret: googleKey,
    expected: [['google-api-key', 'medium', 1]] },
  { name: 'npm token', path: '.github/workflows/release.yml', text: `- run: npm publish\n  env:\n    NODE_AUTH_TOKEN: ${npmToken}`,
    secret: npmToken, expected: [['npm-token', 'high', 3]] },
  { name: 'PEM RSA private key', path: 'deploy/key.txt', text: `# deploy key\n${pem('RSA PRIVATE KEY')}`, secret: keyBody.join(''),
    expected: [['private-key', 'high', 2]], message: 'Hard-coded private key' },
  { name: 'OpenSSH private key', path: 'docs/setup.md', text: `\`\`\`\n${pem('OPENSSH PRIVATE KEY')}\n\`\`\``, secret: keyBody.join(''),
    expected: [['private-key', 'high', 2]] },
  { name: 'private key escaped inside JSON', path: 'service-account.json',
    text: `{"type": "service_account", "private_key": "${pem('PRIVATE KEY').replaceAll('\n', '\\n')}\\n"}`, secret: keyBody.join(''),
    expected: [['private-key', 'high', 1]] },
  { name: 'JSON Web Token', text: `curl -H "Authorization: Bearer ${jwt}" https://api.internal.test`, secret: jwt,
    expected: [['jwt', 'medium', 1]] },
  { name: 'password assignment', text: `const dbPassword = "${password}";`, secret: password,
    expected: [['generic-secret-assignment', 'medium', 1]], message: 'Likely hard-coded password' },
  { name: 'API key in JSON', path: 'config.json', text: `{\n  "api_key": "${apiKey}"\n}`, secret: apiKey,
    expected: [['generic-secret-assignment', 'medium', 2]], message: 'Likely hard-coded API key' },
  { name: 'client secret in YAML', path: 'app.yml', text: `oauth:\n  client_secret: '${clientSecret}'`, secret: clientSecret,
    expected: [['generic-secret-assignment', 'medium', 2]], message: 'Likely hard-coded secret' },
  { name: 'typed token field', text: `class Client {\n  readonly authToken: string = "${authToken}";\n}`, secret: authToken,
    expected: [['generic-secret-assignment', 'medium', 2]], message: 'Likely hard-coded token' },
  { name: 'hex secret', path: 'settings.py', text: `SECRET = "${hexSecret}"`, secret: hexSecret,
    expected: [['generic-secret-assignment', 'medium', 1]] },
  { name: '.env file', path: '.env', text: 'API_URL=https://api.internal.test\nDEBUG=1', secret: 'https://api.internal.test',
    expected: [['sensitive-file', 'medium', 1]], message: 'Sensitive file: environment file' },
  { name: 'environment-specific .env file', path: 'config/.env.production', text: 'LOG_LEVEL=info', secret: 'LOG_LEVEL=info',
    expected: [['sensitive-file', 'medium', 1]] },
  { name: 'key file', path: 'certs/server.key', text: 'stored in the vault', secret: 'stored in the vault',
    expected: [['sensitive-file', 'medium', 1]] },
  { name: 'PEM file with a private key', path: 'certs/bundle.pem', text: `${pem('CERTIFICATE')}\n${pem('PRIVATE KEY')}`,
    secret: keyBody.join(''), expected: [['sensitive-file', 'medium', 1], ['private-key', 'high', 7]] },
  { name: 'SSH private key file', path: '.ssh/id_ed25519', text: pem('OPENSSH PRIVATE KEY'), secret: keyBody.join(''),
    expected: [['sensitive-file', 'medium', 1], ['private-key', 'high', 1]] },
  { name: 'Git credential store', path: '.git-credentials', text: `https://octo:${gitPassword}@github.com`, secret: gitPassword,
    expected: [['sensitive-file', 'medium', 1]], message: 'Sensitive file: Git credential store' },
  { name: '.npmrc with a literal auth token', path: '.npmrc',
    text: `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${registryToken}`, secret: registryToken,
    expected: [['sensitive-file', 'medium', 1]] },
  { name: '.pypirc with a password', path: '.pypirc', text: `[pypi]\nusername = __token__\npassword = ${pypiToken}`, secret: pypiToken,
    expected: [['sensitive-file', 'medium', 1]] },
];

function windows(value: string, size: number): string[] {
  return Array.from({ length: Math.max(1, value.length - size + 1) }, (_, index) => value.slice(index, index + size));
}

test('each rule reports a realistic fake secret by kind, path and line', () => {
  const declared = new Set(secrets.rules?.map(rule => rule.id));
  for (const { name, path = 'src/config.ts', text, expected, message } of hits) {
    const findings = scan(path, text);
    assert.deepEqual(summary(findings), expected, name);
    for (const item of findings) {
      assert.ok(declared.has(item.rule), `${name}: undeclared rule ${item.rule}`);
      assert.equal(item.tool, 'secrets');
      assert.equal(item.category, 'secret');
      assert.equal(item.path, path);
    }
    if (message !== undefined) assert.equal(findings[0]?.message, message, name);
  }
});

test('messages never contain the matched value or any part of it', () => {
  for (const { name, path = 'src/config.ts', text, secret } of hits) {
    for (const { message } of scan(path, text)) {
      assert.ok(message.length > 0);
      const leaked = windows(secret, 6).find(part => message.includes(part));
      assert.equal(leaked, undefined, `${name}: message "${message}" repeats part of the secret`);
    }
  }
});

const misses: readonly { readonly name: string; readonly path?: string; readonly text: string }[] = [
  { name: 'AWS key ID one character short', text: `key = ${awsKeyId.slice(0, -1)}` },
  { name: 'AWS key ID inside a longer word', text: `key = ${awsKeyId}Q` },
  { name: 'AWS documentation key ID', text: 'aws_access_key_id = AKIA' + 'IOSFODNN7EXAMPLE' },
  { name: 'lower-case AWS key ID lookalike', text: `id = akia${fake(lower, 16, 30)}` },
  { name: 'AWS secret next to an unrelated name', text: `checksum = ${awsSecret}` },
  { name: 'AWS documentation secret', text: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY' },
  { name: 'AWS secret one character short', text: `aws_secret_access_key = ${awsSecret.slice(1)}` },
  { name: 'hex digest next to an AWS secret name', text: `aws_secret_key: ${fake(hex, 40, 31)}` },
  { name: 'GitHub token one character short', text: `token ${githubToken.slice(0, -1)}` },
  { name: 'unknown GitHub prefix', text: `id = ghx_${fake(alnum, 36, 4)}` },
  { name: 'masked GitHub token', text: `GITHUB_TOKEN=ghp_${'x'.repeat(36)}` },
  { name: 'GitLab token one character short', text: `glpat-${fake(alnum, 19, 7)}` },
  { name: 'masked GitLab token', text: `token: glpat-${'X'.repeat(20)}` },
  { name: 'Slack token placeholder', text: 'SLACK_TOKEN=xoxb-your-bot-token-here' },
  { name: 'Slack client token prefix', text: `xoxc-${fake(digits, 12, 8)}-${fake(alnum, 24, 10)}` },
  { name: 'Slack documentation webhook', text: 'url: https://hooks.slack.com/services/T00000000/B00000000/' + 'X'.repeat(24) },
  { name: 'Slack webhook without a path', text: 'see https://hooks.slack.com/services/' },
  { name: 'Stripe test key', text: `sk_test_${fake(alnum, 24, 14)}` },
  { name: 'Stripe publishable key', text: `pk_live_${fake(alnum, 24, 14)}` },
  { name: 'Stripe key too short', text: `sk_live_${fake(alnum, 10, 14)}` },
  { name: 'Google key one character short', text: `AIza${fake(alnum, 34, 16)}` },
  { name: 'npm configuration variables', text: 'echo $npm_config_registry $npm_package_version $npm_lifecycle_event' },
  { name: 'npm token one character short', text: `npm_${fake(alnum, 35, 17)}` },
  { name: 'public key block', text: pem('PUBLIC KEY') },
  { name: 'certificate block', text: pem('CERTIFICATE') },
  { name: 'private key marker constants', text: `const header = '${pemHeader('PRIVATE KEY')}';\nconst footer = '${pemFooter('PRIVATE KEY')}';` },
  { name: 'elided private key', text: pem('RSA PRIVATE KEY', ['MIIEowIBAAKCAQEA...']) },
  { name: 'redacted private key', text: pem('PRIVATE KEY', [fake(alnum, 40, 32) + 'REDACTED']) },
  { name: 'private key without a footer', text: [pemHeader('PRIVATE KEY'), ...keyBody].join('\n') },
  { name: 'JWT-like value with two segments', text: `token ${jwt.split('.').slice(0, 2).join('.')}` },
  { name: 'base64url segments without a JWT header', text: `id ${[jwtPart({ foo: 'bar', baz: 1 }), jwtPart({ sub: 'x' }), fake(alnum, 43, 22)].join('.')}` },
  { name: 'changeme password', text: `password = "changeme-${fake(alnum, 12, 40)}"` },
  { name: 'example API key', text: `api_key: "example-${fake(alnum, 16, 41)}"` },
  { name: 'dummy token', text: `token: "dummy${fake(alnum, 16, 42)}"` },
  { name: 'masked secret', text: `secret = "xxx${fake(alnum, 16, 43)}"` },
  { name: 'interpolated password', text: 'password: "${DB_PASSWORD_FROM_ENVIRONMENT}"' },
  { name: 'environment lookup in a string', text: 'token: "process.env.GITHUB_TOKEN_2"' },
  { name: 'environment lookup', text: "const token = process.env.GITHUB_TOKEN ?? '';" },
  { name: 'short password', text: `password = "${fake(alnum, 15, 44)}"` },
  { name: 'password with spaces', text: 'password = "correct horse battery staple 42"' },
  { name: 'low-entropy password', text: 'password = "aaaabbbbaaaabbbb1"' },
  { name: 'camel-cased words', text: 'token = "AuthorizationHeaderName"' },
  { name: 'environment variable name', text: 'token = "GITHUB_TOKEN_2024_VALUE"' },
  { name: 'dotted message key', text: 'password: "auth.password.reset2"' },
  { name: 'file path', text: 'secret = "/run/secrets/db_password1"' },
  { name: 'URL', text: 'token: "https://auth.internal.test/oauth2/token"' },
  { name: 'name that is not a credential', text: `secretName = "${fake(alnum, 24, 45)}"` },
  { name: 'credential word that is not last', text: `password_hint = "${fake(alnum, 24, 46)}"` },
  { name: '.env.example', path: '.env.example', text: 'API_TOKEN=' },
  { name: '.env.sample', path: 'config/.env.sample', text: 'API_TOKEN=' },
  { name: '.env.template', path: '.env.template', text: 'API_TOKEN=' },
  { name: 'environment module', path: 'src/environment.ts', text: 'export const environment = {};' },
  { name: '.envrc', path: '.envrc', text: 'use nix' },
  { name: 'certificate bundle', path: 'certs/ca-bundle.pem', text: `${pem('CERTIFICATE')}\n${pem('CERTIFICATE', keyBody.slice(1))}` },
  { name: '.npmrc with an environment token', path: '.npmrc',
    text: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=https://registry.npmjs.org/' },
  { name: '.npmrc without auth', path: '.npmrc', text: 'save-exact=true' },
  { name: '.pypirc without a password', path: '.pypirc', text: '[distutils]\nindex-servers = pypi\n[pypi]\nusername = __token__' },
  { name: 'SSH public key', path: '.ssh/id_rsa.pub', text: `ssh-ed25519 ${fake(alnum, 68, 50)} octo@host` },
];

test('near misses and placeholders are not reported', () => {
  for (const { name, path = 'src/config.ts', text } of misses) assert.deepEqual(summary(scan(path, text)), [], name);
});

test('lines with the ignore marker are skipped', () => {
  const text = [`const fixture = '${githubToken}'; // ${ignoreMarker}`, `const leaked = '${githubToken}';`].join('\n');
  assert.deepEqual(summary(scan('src/a.ts', text)), [['github-token', 'high', 2]]);
  assert.deepEqual(summary(scan('src/b.ts', `${pemHeader('PRIVATE KEY')} ${ignoreMarker}\n${keyBody.join('\n')}\n${pemFooter('PRIVATE KEY')}`)), []);
  assert.deepEqual(summary(scan('.env', `# ${ignoreMarker}\nDEBUG=1`)), []);
  assert.deepEqual(summary(scan('.npmrc', `//registry.npmjs.org/:_authToken=${registryToken} # ${ignoreMarker}`)), []);
});

test('binary and oversized files are skipped, keystores are flagged by path alone', () => {
  const token = new TextEncoder().encode(`token ${githubToken}\n`);
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...token]);
  assert.deepEqual(scan('assets/logo.png', binary), []);
  assert.deepEqual(scan('slides/deck.key', binary), []);
  for (const path of ['keys/client.p12', 'keys/server.pfx']) assert.deepEqual(summary(scan(path, binary)), [['sensitive-file', 'medium', 1]]);

  const lateNul = new Uint8Array(8 * 1024 + token.length + 1).fill(0x20);
  lateNul.set(token);
  lateNul[lateNul.length - 1] = 0;
  assert.deepEqual(summary(scan('data/log.txt', lateNul)), [['github-token', 'high', 1]]);

  const oversized = new Uint8Array(maxScannedBytes + 1).fill(0x20);
  oversized.set(token);
  assert.deepEqual(scan('dump.sql', oversized), []);
  assert.deepEqual(summary(scan('dump.sql', oversized.subarray(0, maxScannedBytes))), [['github-token', 'high', 1]]);
});

test('the manifest declares a security plugin with one documented rule per secret kind', () => {
  const products = manifestProducts(secrets);
  assert.deepEqual([...products.keys()], [findingResult.id]);
  assert.equal(products.get(findingResult.id)?.metrics, undefined);
  assert.deepEqual(secrets.kinds, ['security']);
  assert.deepEqual(secrets.rules?.map(rule => rule.id), [
    'aws-access-key-id', 'aws-secret-access-key', 'github-token', 'gitlab-token', 'slack-token', 'slack-webhook', 'stripe-secret-key',
    'google-api-key', 'npm-token', 'private-key', 'jwt', 'generic-secret-assignment', 'sensitive-file',
  ]);
  for (const { id, category, description = '' } of secrets.rules ?? []) {
    assert.equal(category, 'secret', id);
    assert.match(description, /^[A-Z].*\.$/, id);
    assert.doesNotMatch(description.slice(0, -1), /[.!?]\s+[A-Z]/, `${id} has more than one sentence`);
    assert.ok(description.includes(ignoreMarker), `${id} does not document the allow-list`);
  }
});

test('claims cover every path, dotfiles included', () => {
  const claimed = exclusionMatcher(secrets.claims?.globs ?? []);
  for (const path of ['src/a.ts', 'README.md', '.env', 'config/.env.local', '.npmrc', '.github/workflows/ci.yml', '.ssh/id_rsa']) {
    assert.ok(claimed(path), path);
  }
});

test('the engine plans and runs the scan operation on a source file', async () => {
  const tasks = plan({ plugins: [secrets], select: ['secrets/scan'], inputs: new Map([['file', sourceFile.id]]) });
  const file = { path: 'src/publish.ts', bytes: new TextEncoder().encode(`export const key = '${npmToken}';\n`) };
  const outcome = (await execute(tasks, new Map([['file', { contract: sourceFile.id, value: file }]]))).get('secrets/scan');
  assert.ok(outcome?.state === 'completed' && findingResult.accepts(outcome.product.value));
  assert.deepEqual(summary(outcome.product.value.findings), [['npm-token', 'high', 1]]);
});
