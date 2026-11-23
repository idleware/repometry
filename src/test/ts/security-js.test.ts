import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract } from '../../main/ts/core/engine/plugin.js';
import { findingResult } from '../../main/ts/core/model/finding.js';
import type { Finding } from '../../main/ts/core/model/finding.js';
import { sourceExtensions, sourceFile, workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { isSecretName, jsSecurity } from '../../main/ts/plugins/language-js/js-security.js';

async function scanBytes(path: string, bytes: Uint8Array): Promise<readonly Finding[]> {
  const file = { path, bytes };
  const [operation] = jsSecurity.operations;
  const result = await operation!.execute({ read<T>(port: string, contract: DataContract<T>): T {
    assert.equal(port, 'source');
    assert.ok(contract.accepts(file));
    return file;
  } });
  assert.ok(findingResult.accepts(result));
  return result.findings;
}

function scan(source: string, path = 'src/app.ts'): Promise<readonly Finding[]> {
  return scanBytes(path, new TextEncoder().encode(source));
}

/** `rule:line` pairs, which pin both what was found and where. */
async function hits(source: string, path?: string): Promise<string[]> {
  return (await scan(source, path)).map(finding => `${finding.rule}:${finding.line}`);
}

test('the manifest declares a security inspection over the JS/TS extensions with one described rule per check', () => {
  assert.equal(jsSecurity.id, 'js-security');
  assert.equal(jsSecurity.version, '1.0.0');
  assert.equal(jsSecurity.api, pluginApi);
  assert.deepEqual(jsSecurity.kinds, ['security']);
  assert.deepEqual(jsSecurity.claims, { extensions: sourceExtensions });
  assert.deepEqual(jsSecurity.produces, [{ contract: findingResult.id, persistence: 'report' }]);
  assert.deepEqual(jsSecurity.rules?.map(rule => rule.id), ['eval', 'child-process-injection', 'vm-code-execution', 'dom-xss',
    'tls-verification-disabled', 'weak-hash', 'insecure-random', 'http-url']);
  for (const rule of jsSecurity.rules ?? []) {
    assert.equal(rule.category, 'security');
    assert.match(rule.description ?? '', /^[A-Za-z].*\.$/);
  }
  const [operation] = jsSecurity.operations;
  assert.equal(jsSecurity.operations.length, 1);
  assert.equal(operation?.id, 'scan');
  assert.equal(operation?.role, 'inspection');
  assert.deepEqual(operation?.inputs, { source: sourceFile });
  assert.equal(operation?.output, findingResult);
});

test('findings carry the tool, rule level, a one-sentence message and the node line span', async () => {
  const findings = await scan('const html = 1;\nel.innerHTML = `\n  <b>${html}</b>\n`;\n', 'web/view.js');
  assert.deepEqual(findings.map(({ message, ...rest }) => rest), [{ tool: 'js-security', rule: 'dom-xss', category: 'security',
    level: 'medium', path: 'web/view.js', line: 2, endLine: 4 }]);
  assert.match(findings[0]!.message, /^[^.]+innerHTML[^.]+\.$/);
});

test('eval flags dynamic code strings and the Function constructor but not literals or unrelated eval methods', async () => {
  assert.deepEqual(await hits(`
eval(userInput);
const add = new Function('a', 'b', body);
globalThis.eval(code);
const compiled = Function(\`return \${expression}\`);
`), ['eval:2', 'eval:3', 'eval:4', 'eval:5']);
  assert.deepEqual(await hits(`
eval('1 + 1');
const root = new Function('return this')();
const add = new Function('a', 'b', 'return a + b');
await redis.eval(script, 1, key);
eval();
`), []);
  assert.ok((await scan('eval(input);')).every(finding => finding.level === 'high'));
});

test('child-process-injection follows exec and execSync bindings from imports, require and promisify', async () => {
  assert.deepEqual(await hits(`
import { exec, execSync } from 'node:child_process';
import * as cp from 'child_process';
import { promisify } from 'node:util';
const run = promisify(exec);
exec(\`git log \${branch}\`, done);
execSync('rm -rf ' + directory);
cp.exec(\`tar -xf \${archive}\`);
await run(\`npm view \${name}\`);
`), ['child-process-injection:6', 'child-process-injection:7', 'child-process-injection:8', 'child-process-injection:9']);
  assert.deepEqual(await hits(`
const { execSync: sh } = require('child_process');
const childProcess = require('node:child_process');
sh(\`ls \${directory}\`);
childProcess.execSync('git checkout ' + ref);
require('child_process').exec(\`kill \${pid}\`);
`, 'scripts/tool.cjs'), ['child-process-injection:4', 'child-process-injection:5', 'child-process-injection:6']);
  assert.ok((await scan(`import { exec } from 'child_process';\nexec(\`ls \${dir}\`);`)).every(finding => finding.level === 'high'));
});

test('child-process-injection stays quiet for argument arrays, fixed commands and RegExp exec', async () => {
  assert.deepEqual(await hits(`
import { exec, execFile, spawn, execFileSync } from 'node:child_process';
execFile('git', ['log', branch]);
execFileSync('tar', ['-xf', archive]);
spawn('npm', ['view', name], { stdio: 'inherit' });
exec('git status');
exec(\`git status\`);
exec('git ' + 'status');
exec(command);
/(\\d+)/.exec(\`\${value}\`);
pattern.exec('prefix' + input);
`), []);
  // An exec that does not come from child_process is not a shell call.
  assert.deepEqual(await hits('const exec = (query: string) => db.run(query);\nexec(`SELECT * FROM t WHERE id = ${id}`);'), []);
});

test('vm-code-execution flags dynamic code in vm run calls and Script, only for bindings from the vm module', async () => {
  assert.deepEqual(await hits(`
import vm from 'node:vm';
import { runInThisContext, Script } from 'vm';
vm.runInNewContext(code, sandbox);
vm.runInContext(source, context);
runInThisContext(wrapper);
const script = new vm.Script(text);
new Script(\`(\${fn})()\`);
`), ['vm-code-execution:4', 'vm-code-execution:5', 'vm-code-execution:6', 'vm-code-execution:7', 'vm-code-execution:8']);
  assert.deepEqual(await hits(`
import vm from 'node:vm';
vm.runInNewContext('1 + 1', {});
new vm.Script('globalThis.ready = true');
vm.isContext(sandbox);
`), []);
  // A Vue-style view model named vm is not the vm module.
  assert.deepEqual(await hits('const vm = useViewModel();\nvm.runInContext(code);'), []);
  assert.ok((await scan(`const vm = require('vm');\nvm.runInThisContext(code);`)).every(finding => finding.level === 'medium'));
});

test('dom-xss flags dynamic markup sinks and stays quiet for text, literals and sanitized values', async () => {
  assert.deepEqual(await hits(`
element.innerHTML = html;
row.outerHTML = \`<tr><td>\${name}</td></tr>\`;
list.innerHTML += item;
document.write(markup);
window.document.writeln('<p>' + text + '</p>');
table.insertAdjacentHTML('beforeend', rowHtml);
`, 'web/app.js'), ['dom-xss:2', 'dom-xss:3', 'dom-xss:4', 'dom-xss:5', 'dom-xss:6', 'dom-xss:7']);
  assert.deepEqual(await hits(`
element.textContent = html;
element.innerText = name;
element.innerHTML = '';
element.innerHTML += '<br>';
element.innerHTML = DOMPurify.sanitize(html);
element.innerHTML = escapeHtml(name);
table.insertAdjacentHTML('beforeend', '<hr>');
table.insertAdjacentText('beforeend', rowHtml);
document.write('<p>static</p>');
const markup = element.innerHTML;
logger.write(message);
`, 'web/app.js'), []);
});

test('tls-verification-disabled flags rejectUnauthorized false and NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
  assert.deepEqual(await hits(`
const request = https.request({ host, rejectUnauthorized: false });
const agent = new https.Agent({ 'rejectUnauthorized': false });
options.rejectUnauthorized = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;
`), ['tls-verification-disabled:2', 'tls-verification-disabled:3', 'tls-verification-disabled:4',
    'tls-verification-disabled:5', 'tls-verification-disabled:6']);
  assert.deepEqual(await hits(`
const request = https.request({ host, rejectUnauthorized: true, ca });
const { rejectUnauthorized = true } = options;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
const flag = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
interface Options { rejectUnauthorized: false }
`), []);
  assert.ok((await scan('connect({ rejectUnauthorized: false });')).every(finding => finding.level === 'high'));
});

test('weak-hash flags MD5 and SHA-1 literals in createHash and createHmac only', async () => {
  assert.deepEqual(await hits(`
import crypto, { createHmac } from 'node:crypto';
const etag = crypto.createHash('md5').update(body).digest('hex');
const signature = createHmac('sha1', secret).update(payload).digest('base64');
const legacy = require('crypto').createHash('SHA1');
`), ['weak-hash:3', 'weak-hash:4', 'weak-hash:5']);
  assert.deepEqual(await hits(`
import crypto from 'node:crypto';
const digest = crypto.createHash('sha256').update(body).digest('hex');
const mac = crypto.createHmac('sha512', secret);
const dynamic = crypto.createHash(algorithm);
const label = 'md5';
`), []);
  const [finding] = await scan(`crypto.createHash('md5');`);
  assert.equal(finding?.level, 'medium');
  assert.match(finding?.message ?? '', /MD5/);
});

test('insecure-random flags Math.random flowing into secret-named variables, properties and returns', async () => {
  assert.deepEqual(await hits(`
const token = Math.random().toString(36).slice(2);
user.resetPasswordToken = Math.floor(Math.random() * 1e9).toString();
const session = { nonce: \`\${Date.now()}-\${Math.random()}\` };
function generateSalt() {
  return Math.random().toString(16);
}
const apiKey = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
let otp = '';
for (let i = 0; i < 6; i++) otp += Math.floor(Math.random() * 10);
class Auth { secret = Math.random(); makeToken = () => Math.random().toString(36); }
`), ['insecure-random:2', 'insecure-random:3', 'insecure-random:4', 'insecure-random:6', 'insecure-random:8',
    'insecure-random:10', 'insecure-random:11', 'insecure-random:11']);
  assert.ok((await scan('const token = Math.random();')).every(finding => finding.level === 'low'));
});

test('insecure-random stays quiet for non-secret names, crypto randomness and JSX keys', async () => {
  assert.deepEqual(await hits(`
const delay = Math.random() * 1000;
const token = crypto.randomUUID();
const secret = crypto.randomBytes(32).toString('hex');
const key = Math.random();
const tokenIndex = Math.floor(Math.random() * tokens.length);
if (Math.random() < 0.5) password = fallback;
function generateToken() {
  console.log(Math.random());
  return crypto.randomUUID();
}
const jitter = () => Math.random() * 50;
`), []);
  assert.deepEqual(await hits(`
export function PasswordList({ items }: { items: string[] }) {
  return <ul>{items.map(item => <li key={Math.random()}>{item}</li>)}</ul>;
}
`, 'web/list.tsx'), []);
  assert.equal(isSecretName('csrfToken'), true);
  assert.equal(isSecretName('API_KEY'), true);
  assert.equal(isSecretName('accessKeys'), true);
  assert.equal(isSecretName('cacheKey'), false);
  assert.equal(isSecretName('keyboard'), false);
  assert.equal(isSecretName('tokenizer'), false);
});

test('http-url flags plain HTTP to public hosts and skips local, example, namespace and partial URLs', async () => {
  assert.deepEqual(await hits(`
const response = await fetch('http://api.vendor.io/v1/users');
const script = \`http://cdn.vendor.net/lib.js\`;
const link = <a href="http://docs.vendor.org/guide">Guide</a>;
const proxy = 'http://user:pass@proxy.corp.com:8080';
`, 'web/links.tsx'), ['http-url:2', 'http-url:3', 'http-url:4', 'http-url:5']);
  assert.deepEqual(await hits(`
const secure = 'https://api.vendor.io/v1/users';
const dev = 'http://localhost:3000/api';
const loopback = 'http://127.0.0.1:8080';
const any = 'http://0.0.0.0:9000';
const ipv6 = 'http://[::1]:4000';
const docs = 'http://example.com/path';
const sample = 'http://www.example.org';
const svg = <svg xmlns="http://www.w3.org/2000/svg" />;
const soap = 'http://schemas.xmlsoap.org/soap/envelope/';
const schema = { $schema: 'http://json-schema.org/draft-07/schema#' };
const insecure = url.startsWith('http://');
const built = 'http://' + host + '/path';
const internal = 'http://backend:8080/health';
const dynamic = \`http://\${host}/path\`;
type Scheme = 'http://vendor.io';
`, 'web/links.tsx'), []);
  const [finding] = await scan(`const base = 'http://api.vendor.io';`);
  assert.equal(finding?.level, 'low');
  assert.match(finding?.message ?? '', /api\.vendor\.io/);
});

test('a file that fails to parse or is not UTF-8 yields no findings', async () => {
  assert.deepEqual(await scan('eval(input);\nconst = ;\n'), []);
  assert.deepEqual(await scan('el.innerHTML = html as string;', 'web/app.js'), []);
  assert.deepEqual(await scanBytes('src/app.js', new Uint8Array([0x65, 0x76, 0x61, 0x6c, 0x28, 0xff, 0x29])), []);
});

test('TypeScript wrappers and module syntax per extension parse like the language plugin', async () => {
  assert.deepEqual(await hits(`
import { exec } from 'child_process';
exec(\`git \${args.join(' ')}\` as string);
element!.innerHTML = (markup satisfies string);
`, 'src/tool.mts'), ['child-process-injection:3', 'dom-xss:4']);
  assert.deepEqual(await hits('import cp = require("child_process");\ncp.execSync("ls " + dir);', 'src/legacy.ts'),
    ['child-process-injection:2']);
  assert.deepEqual(await hits('export declare const base = "http://vendor.io";\nexport type Url = "http://other.io";', 'types/index.d.ts'),
    ['http-url:1']);
});

test('findings reach the analysed report next to the built-in plugins', async () => {
  const snapshot = workingSnapshot([
    { path: 'src/run.js', bytes: new TextEncoder().encode("import { execSync } from 'child_process';\nexecSync(`ls ${dir}`);\n") },
    { path: 'src/broken.js', bytes: new TextEncoder().encode('eval(input);\nconst = ;\n') },
    { path: 'src/safe.ts', bytes: new TextEncoder().encode("export const url: string = 'https://vendor.io';\n") },
  ]);
  const report = await analyzeSnapshot({ snapshot, excludedOutput: null }, [jsSecurity]);
  const security = (report.findings ?? []).filter(finding => finding.tool === 'js-security');
  assert.deepEqual(security.map(({ rule, path, line, level }) => ({ rule, path, line, level })),
    [{ rule: 'child-process-injection', path: 'src/run.js', line: 2, level: 'high' }]);
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.operation === 'babel-syntax/parse' && diagnostic.path === 'src/broken.js'));
  assert.ok(!report.diagnostics.some(diagnostic => diagnostic.operation === 'js-security/scan'));
  assert.deepEqual(report.pluginData?.rules.find(item => item.plugin === 'js-security')?.rules, jsSecurity.rules);
});
