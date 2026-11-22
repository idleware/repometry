import type { AnalysisExecutor } from '../../core/usecases/inspect.js';
import { readReport } from '../../report/json/validation/report.js';
import { encodeWorkerInput, maxWorkerInput, maxWorkerResult, workerRoute } from './worker-protocol.js';

export function remoteExecutor(endpoint: string, token: string): AnalysisExecutor {
  const base = new URL(endpoint);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for a remote worker or HTTP over loopback');
  }
  if (base.username || base.password || base.search || base.hash) throw new Error('Invalid worker base URL');
  base.pathname = base.pathname.replace(/\/+$/, '') + workerRoute;
  return async input => {
    const body = encodeWorkerInput(input);
    if (Buffer.byteLength(body) > maxWorkerInput) throw new Error('Worker input exceeds 16 MiB');
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body, signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Worker request failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error('Missing worker response');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxWorkerResult) {
          await reader.cancel();
          throw new Error('Worker response exceeds 64 MiB');
        }
        parts.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return readReport(JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown);
  };
}
