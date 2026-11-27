import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { extname } from 'node:path';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export async function serveAssets(port: number, asset: (name: string) => Promise<Uint8Array | undefined>, cleanup?: () => void) {
  const handle: RequestListener = async (request, response) => {
    const port = request.socket.localPort;
    const host = request.headers.host?.toLowerCase();
    if (port === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = request.url?.split('?', 1)[0];
    const name = path === '/' ? 'index.html' : path?.startsWith('/') ? path.slice(1) : '';
    let data: Uint8Array | undefined;
    try {
      data = await asset(name);
    } catch {
      response.writeHead(500).end();
      return;
    }
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    const contentType = name.startsWith('sources/') ? 'text/plain; charset=utf-8'
      : contentTypes.get(extname(name)) ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType, 'Content-Length': data.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  };
  const server = await listen('127.0.0.1', port, handle);
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Cannot determine the viewer address');
  }
  const ipv6 = await listen('::1', address.port, handle).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error &&
      (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' || error.code === 'EADDRINUSE')) return undefined;
    server.close();
    throw error;
  });
  return { url: `http://127.0.0.1:${address.port}/`, close: () => { cleanup?.(); server.close(); ipv6?.close(); } };
}

async function listen(host: string, port: number, handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
