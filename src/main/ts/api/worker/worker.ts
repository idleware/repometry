import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnalysisExecutor } from '../../core/usecases/inspect.js';
import { utf8 } from '../../core/model/snapshot.js';
import { decodeWorkerInput, maxWorkerInput, maxWorkerResult, workerRoute } from './worker-protocol.js';

export async function serveWorker(host: '127.0.0.1' | '0.0.0.0', port: number, token: string, analyze: AnalysisExecutor,
  isSource: (path: string) => boolean): Promise<{ url: string; close: () => void }> {
  let busy = false;
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 5_000 }, (request, response) => {
    if (request.url !== workerRoute) { reply(response, 404, 'Unknown worker route'); return; }
    if (request.method !== 'POST') { reply(response, 405, 'Use POST'); return; }
    if (!authorized(request, token)) { reply(response, 401, 'Invalid token'); return; }
    if (busy) { reply(response, 503, 'Worker is busy'); return; }
    busy = true;
    void handle(request, response, analyze, isSource).finally(() => { busy = false; });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Cannot determine the worker address');
  }
  return { url: `http://${host}:${address.port}/`, close: () => server.close() };
}

async function handle(request: IncomingMessage, response: ServerResponse, analyze: AnalysisExecutor,
  isSource: (path: string) => boolean): Promise<void> {
  const declared = Number(request.headers['content-length']);
  if (declared > maxWorkerInput) { reply(response, 413, 'Worker input exceeds 16 MiB'); return; }
  const parts: Buffer[] = [];
  let size = 0;
  let payload: ReturnType<typeof decodeWorkerInput>;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > maxWorkerInput) { reply(response, 413, 'Worker input exceeds 16 MiB'); return; }
      parts.push(bytes);
    }
    payload = decodeWorkerInput(JSON.parse(utf8(Buffer.concat(parts))) as unknown, isSource);
  } catch {
    reply(response, 400, 'Invalid worker input');
    return;
  }
  try {
    const result = JSON.stringify(await analyze(payload));
    if (Buffer.byteLength(result) > maxWorkerResult) { reply(response, 422, 'Report exceeds 64 MiB'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(result);
  } catch {
    reply(response, 500, 'Worker analysis failed');
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reply(response: ServerResponse, status: number, error: string): void {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
  response.end(JSON.stringify({ error }));
}
