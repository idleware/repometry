import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { manifestProducts } from '../../main/ts/core/engine/manifest.js';
import { pluginApi } from '../../main/ts/core/engine/plugin.js';
import type { DataContract } from '../../main/ts/core/engine/plugin.js';
import { findingResult } from '../../main/ts/core/model/finding.js';
import type { Finding } from '../../main/ts/core/model/finding.js';
import { sourceFile, workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { dockerfile } from '../../main/ts/plugins/security/dockerfile.js';

const digest = (char: string): string => `sha256:${char.repeat(64)}`;

function scan(text: string, path = 'Dockerfile'): readonly Finding[] {
  const file = { path, bytes: new TextEncoder().encode(text) };
  const result = dockerfile.operations[0]!.execute({
    read<T>(port: string, contract: DataContract<T>): T {
      assert.equal(port, 'source');
      if (!contract.accepts(file)) throw new Error(`Unexpected contract ${contract.id}`);
      return file;
    },
  });
  assert.ok(findingResult.accepts(result));
  for (const finding of result.findings) {
    assert.equal(finding.tool, 'dockerfile');
    assert.equal(finding.category, 'infrastructure');
    assert.equal(finding.path, path);
    assert.match(finding.message, /^[A-Z].*\.$/);
    assert.doesNotMatch(finding.message, /\.\s/);
  }
  return result.findings;
}

function located(findings: readonly Finding[]): string[] {
  return findings.map(({ rule, line, endLine }) => `${rule} ${line}-${endLine}`);
}

function dockerfileOf(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

test('the plugin declares a security manifest with one scan inspection over container files', () => {
  assert.equal(dockerfile.id, 'dockerfile');
  assert.equal(dockerfile.version, '1.0.0');
  assert.equal(dockerfile.api, pluginApi);
  assert.deepEqual(dockerfile.kinds, ['security']);
  assert.deepEqual(dockerfile.claims, { globs: ['**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/Containerfile'] });
  assert.deepEqual(dockerfile.produces, [{ contract: findingResult.id, persistence: 'report' }]);
  assert.deepEqual(dockerfile.rules?.map(rule => rule.id), ['unpinned-base-image', 'runs-as-root', 'remote-add', 'pipe-to-shell',
    'secret-in-env', 'apt-unpinned-upgrade', 'sudo-usage']);
  for (const rule of dockerfile.rules ?? []) {
    assert.equal(rule.category, 'infrastructure');
    assert.match(rule.description ?? '', /^[A-Z].*\.$/);
    assert.doesNotMatch(rule.description ?? '', /\.\s/);
  }
  assert.equal(dockerfile.operations.length, 1);
  const [operation] = dockerfile.operations;
  assert.equal(operation?.id, 'scan');
  assert.equal(operation?.role, 'inspection');
  assert.deepEqual(operation?.inputs, { source: sourceFile });
  assert.equal(operation?.output, findingResult);
  assert.ok(manifestProducts(dockerfile, false)?.has(findingResult.id));
});

test('unpinned-base-image flags untagged and latest images but not digests, scratch or earlier stages', () => {
  const findings = scan(dockerfileOf(
    'FROM python AS deps',
    'FROM ubuntu:latest AS tools',
    'FROM localhost:5000/team/app AS cache',
    'FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS build',
    `FROM node:20.11.1-bookworm-slim@${digest('a')} AS web`,
    `FROM nginx@${digest('b')}`,
    'FROM scratch',
    'FROM build',
    'FROM DEPS AS final',
    'USER 65532',
  )).filter(finding => finding.rule === 'unpinned-base-image');
  assert.deepEqual(located(findings), ['unpinned-base-image 1-1', 'unpinned-base-image 2-2', 'unpinned-base-image 3-3']);
  assert.ok(findings.every(finding => finding.level === 'medium'));
  assert.match(findings[0]!.message, /python has no tag or digest/);
  assert.match(findings[1]!.message, /ubuntu:latest uses the mutable latest tag/);
  assert.match(findings[2]!.message, /localhost:5000\/team\/app/);
});

test('unpinned-base-image expands global ARG defaults and skips references it cannot resolve', () => {
  const findings = scan(dockerfileOf(
    'ARG NODE_VERSION=20.11.1',
    'ARG BASE_IMAGE',
    'ARG RUNTIME=gcr.io/distroless/nodejs20-debian12',
    'FROM node:${NODE_VERSION}-alpine AS build',
    'FROM ${BASE_IMAGE} AS custom',
    'FROM ${BASE_IMAGE:-alpine:3.20} AS tools',
    'FROM $RUNTIME',
    'USER nonroot',
  ));
  assert.deepEqual(located(findings), ['unpinned-base-image 7-7']);
  assert.match(findings[0]!.message, /gcr\.io\/distroless\/nodejs20-debian12 has no tag/);
});

test('runs-as-root flags a final stage without USER at its FROM and a final USER root at that instruction', () => {
  const missing = scan(dockerfileOf(
    'FROM node:20-bookworm-slim',
    'WORKDIR /app',
    'COPY --chown=node:node . .',
    'RUN npm ci --omit=dev',
    'CMD ["node", "server.js"]',
  ));
  assert.deepEqual(located(missing), ['runs-as-root 1-1']);
  assert.equal(missing[0]!.level, 'medium');

  const root = scan(dockerfileOf(
    'FROM python:3.12-slim',
    'RUN useradd --create-home app',
    'USER app',
    'RUN pip install --no-cache-dir -r requirements.txt',
    'USER root',
    'CMD ["gunicorn", "app:server"]',
  ));
  assert.deepEqual(located(root), ['runs-as-root 5-5']);

  const numeric = scan(dockerfileOf('FROM alpine:3.20 AS build', 'USER app', 'FROM alpine:3.20', 'USER 0:0'));
  assert.deepEqual(located(numeric), ['runs-as-root 4-4']);
});

test('runs-as-root accepts USER node, a root builder before an unprivileged runtime, inherited users and nonroot images', () => {
  assert.deepEqual(scan(dockerfileOf(
    'FROM node:20.11.1-alpine',
    'WORKDIR /home/node/app',
    'COPY --chown=node:node . .',
    'USER node',
    'CMD ["node", "index.js"]',
  )), []);
  assert.deepEqual(scan(dockerfileOf(
    'FROM golang:1.22-bookworm AS build',
    'WORKDIR /src',
    'COPY . .',
    'RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server',
    '',
    'FROM debian:bookworm-slim',
    'RUN useradd --system --uid 10001 app',
    'COPY --from=build /out/server /usr/local/bin/server',
    'USER 10001:10001',
    'ENTRYPOINT ["server"]',
  )), []);
  assert.deepEqual(scan(dockerfileOf('FROM node:20-alpine AS base', 'USER node', 'FROM base AS runtime', 'COPY . .')), []);
  assert.deepEqual(scan(dockerfileOf(
    'FROM golang:1.22 AS build',
    'RUN go build -o /server .',
    'FROM gcr.io/distroless/static-debian12:nonroot',
    'COPY --from=build /server /server',
  )), []);
});

test('remote-add flags ADD of an http(s) URL without a checksum and never repeats the URL', () => {
  const findings = scan(dockerfileOf(
    'FROM alpine:3.20',
    'ADD https://github.com/krallin/tini/releases/download/v0.19.0/tini-static /sbin/tini',
    'ADD ["http://downloads.example.com/config.tar.gz", "/opt/"]',
    `ADD --checksum=${digest('c')} https://downloads.example.com/agent.tar.gz /opt/agent/`,
    'ADD vendor.tar.gz /opt/vendor/',
    'COPY https-proxy.conf /etc/nginx/conf.d/',
    'USER nobody',
  ));
  assert.deepEqual(located(findings), ['remote-add 2-2', 'remote-add 3-3']);
  assert.ok(findings.every(finding => finding.level === 'medium' && !/github|example\.com/.test(finding.message)));
});

test('pipe-to-shell flags curl and wget output piped or substituted into a shell', () => {
  const findings = scan(dockerfileOf(
    'FROM rust:1.79-slim',
    "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
    'RUN wget -qO- https://get.docker.com \\',
    '    | sudo -E bash -',
    'RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"',
    'RUN set -eux; \\',
    '    curl -fsSL https://deb.nodesource.com/setup_20.x 2>&1 | /bin/bash -',
    'USER 10001',
  )).filter(finding => finding.rule === 'pipe-to-shell');
  assert.deepEqual(located(findings), ['pipe-to-shell 2-2', 'pipe-to-shell 3-4', 'pipe-to-shell 5-5', 'pipe-to-shell 6-7']);
  assert.ok(findings.every(finding => finding.level === 'high'));
});

test('pipe-to-shell accepts a checksum-verified download and pipes into non-shell tools', () => {
  assert.deepEqual(scan(dockerfileOf(
    'FROM debian:bookworm-slim',
    'ARG KUBECTL_SHA256=7c6f5f3e4f2ad5ac7c7a9bf4b3a3e2f1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5',
    'RUN curl -fsSLo /tmp/kubectl https://dl.k8s.io/release/v1.30.2/bin/linux/amd64/kubectl \\',
    '    && echo "${KUBECTL_SHA256}  /tmp/kubectl" | sha256sum -c - \\',
    '    && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl',
    'RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg',
    'RUN curl -fsSL https://downloads.example.com/app.tar.gz | tar -xz -C /opt',
    'RUN echo "never run curl https://example.com | sh" > /etc/motd',
    'USER 10001',
  )), []);
});

test('secret-in-env flags literal secret values in ENV and ARG without echoing them', () => {
  const values = ['s3cr3t-Pa55', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'sk-live-1234567890'];
  const findings = scan(dockerfileOf(
    'FROM postgres:16-alpine',
    'ENV POSTGRES_USER=app \\',
    `    POSTGRES_PASSWORD="${values[0]}" \\`,
    '    PGDATA=/var/lib/postgresql/data/pgdata',
    `ARG GITHUB_TOKEN=${values[1]}`,
    `ENV AWS_SECRET_ACCESS_KEY ${values[2]}`,
    `env apiKey=${values[3]}`,
    'USER postgres',
  ));
  assert.deepEqual(located(findings), ['secret-in-env 2-4', 'secret-in-env 5-5', 'secret-in-env 6-6', 'secret-in-env 7-7']);
  assert.ok(findings.every(finding => finding.level === 'high'));
  assert.deepEqual(findings.map(finding => /^(?:ENV|ARG) (\S+)/.exec(finding.message)?.[1]),
    ['POSTGRES_PASSWORD', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'apiKey']);
  for (const finding of findings) {
    for (const value of values) assert.ok(!finding.message.includes(value), finding.message);
  }
});

test('secret-in-env accepts an ARG without a default, empty values, variable references and non-secret names', () => {
  assert.deepEqual(scan(dockerfileOf(
    'FROM node:20.11.1-alpine',
    'ARG NPM_TOKEN',
    'ARG GITHUB_TOKEN=',
    'ENV SESSION_SECRET=""',
    'ENV NODE_AUTH_TOKEN=${NPM_TOKEN}',
    'ENV DB_PASSWORD_FILE=/run/secrets/db_password',
    'ENV TOKENIZERS_PARALLELISM=false',
    'ENV NPM_CONFIG_USERCONFIG=/run/secrets/npmrc',
    'RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci',
    'USER node',
  )), []);
});

test('apt-unpinned-upgrade flags apt-get upgrade and dist-upgrade but not pinned installs', () => {
  const findings = scan(dockerfileOf(
    'FROM ubuntu:24.04',
    'RUN apt-get update && apt-get upgrade -y',
    'RUN DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold -y dist-upgrade',
    'RUN apt-get update \\',
    ' && apt-get install -y --no-install-recommends curl=8.5.0-2ubuntu10 \\',
    ' && rm -rf /var/lib/apt/lists/*',
    'USER ubuntu',
  ));
  assert.deepEqual(located(findings), ['apt-unpinned-upgrade 2-2', 'apt-unpinned-upgrade 3-3']);
  assert.ok(findings.every(finding => finding.level === 'low'));
});

test('sudo-usage flags commands run through sudo but not installing or mentioning it', () => {
  const findings = scan(dockerfileOf(
    'FROM ubuntu:24.04',
    'RUN apt-get update && apt-get install -y --no-install-recommends sudo',
    "RUN useradd -m dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev",
    'USER dev',
    'RUN sudo apt-get install -y git',
    'RUN echo "use sudo for admin tasks" > /etc/motd',
  ));
  assert.deepEqual(located(findings), ['sudo-usage 5-5']);
  assert.equal(findings[0]!.level, 'low');
});

test('the parser joins continuations across comment and blank lines, ignores case and accepts CRLF', () => {
  const text = dockerfileOf(
    'from debian:bookworm-slim',
    'run apt-get update \\',
    '    # refresh the index before installing',
    '    && apt-get install -y --no-install-recommends ca-certificates \\',
    '',
    '    && sudo rm -rf /var/lib/apt/lists/*',
    'user nobody',
  );
  assert.deepEqual(located(scan(text)), ['sudo-usage 2-6']);
  assert.deepEqual(located(scan(text.replaceAll('\n', '\r\n'), 'build/Containerfile')), ['sudo-usage 2-6']);
});

test('the escape directive switches line continuations to backticks only when it leads the file', () => {
  const body = [
    'FROM mcr.microsoft.com/windows/servercore:ltsc2022',
    'RUN powershell -Command `',
    "    $ErrorActionPreference = 'Stop'; `",
    '    Invoke-WebRequest https://downloads.example.com/tools.zip -OutFile C:\\tools.zip',
    'ADD https://downloads.example.com/tool.zip C:\\tools\\',
    'USER ContainerUser',
  ];
  assert.deepEqual(located(scan(dockerfileOf('# syntax=docker/dockerfile:1', '# escape=`', ...body))), ['remote-add 7-7']);
  // Without the directive the trailing backslash continues ADD into the USER line, so no USER remains.
  assert.deepEqual(located(scan(dockerfileOf('# a comment ends the directive block', '# escape=`', ...body))),
    ['runs-as-root 3-3', 'remote-add 7-8']);
});

test('heredoc bodies are skipped as instructions and only shell heredocs are scanned as scripts', () => {
  const findings = scan(dockerfileOf(
    '# syntax=docker/dockerfile:1.7',
    'FROM alpine:3.20',
    'COPY <<EOF /etc/motd',
    'RUN curl https://downloads.example.com/install.sh | sh',
    'USER root',
    'EOF',
    'RUN <<-SCRIPT',
    '\tset -eu',
    '\t# no sudo needed here',
    '\twget -qO- https://get.example.com/install | sh',
    '\tSCRIPT',
    "RUN cat <<'CONF' > /etc/app.conf",
    'hook = "curl https://downloads.example.com | sh"',
    'CONF',
    'USER app',
  ));
  assert.deepEqual(located(findings), ['pipe-to-shell 7-11']);
});

test('the snapshot analysis routes only claimed container files to the plugin', async () => {
  const insecure = new TextEncoder().encode('FROM node\nRUN curl -fsSL https://example.com/install.sh | bash\n');
  const paths = ['Dockerfile', 'services/api/Dockerfile.prod', 'deploy/worker.dockerfile', 'Containerfile', 'src/install.js'];
  const report = await analyzeSnapshot({ excludedOutput: null, snapshot: workingSnapshot(paths.map(path => ({ path, bytes: insecure }))) },
    [dockerfile]);
  const scanned = report.findings?.filter(finding => finding.tool === 'dockerfile') ?? [];
  assert.deepEqual([...new Set(scanned.map(finding => finding.path))].sort(),
    ['Containerfile', 'Dockerfile', 'deploy/worker.dockerfile', 'services/api/Dockerfile.prod']);
  assert.deepEqual(scanned.filter(finding => finding.path === 'Dockerfile').map(finding => finding.rule),
    ['runs-as-root', 'unpinned-base-image', 'pipe-to-shell']);
  assert.ok(report.diagnostics.every(diagnostic => !diagnostic.operation.startsWith('dockerfile/')));
  assert.deepEqual(report.pluginData?.rules.find(item => item.plugin === 'dockerfile')?.rules, dockerfile.rules);
});
