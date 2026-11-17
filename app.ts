// HTTP server: routing, auth, JSON plumbing. One process, stdlib only.
// Auth: every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`;
// no token or a wrong token -> 401. /healthz takes no token.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './forge/store.ts';
import { handleRest } from './forge/rest.ts';
import { executeGraphQL } from './forge/graphql.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './forge/githttp.ts';
import { handleMcp } from './forge/mcp.ts';

export interface AppOptions {
  token?: string;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

// The starter's main.ts calls createApp() with no arguments; the token comes
// from the entry's environment (MAKEFUN_SHOP_TOKEN).
export function createApp(options?: AppOptions): ReturnType<typeof createServer> {
  const store = new Store();
  const token = options?.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const pathname = url.pathname;

      // /healthz — no auth, always 200.
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Auth: Bearer <MAKEFUN_SHOP_TOKEN> on everything else.
      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!token || bearer !== token) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      const segments = pathname.split('/').filter((s) => s.length > 0).map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

      // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -'.git'.length);
        const action = segments[2] as string | undefined;
        if (action === 'info' && segments[3] === 'refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : undefined;
          const result = handleInfoRefs(store, owner, repoName, service, protocol);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : undefined;
          const result = handleUploadPack(store, owner, repoName, body, protocol);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleReceivePack(store, owner, repoName, body);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL: POST /api/graphql
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = executeGraphQL(store, origin, parsed);
        sendJson(res, 200, result);
        return;
      }

      // MCP: POST /mcp
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = handleMcp(store, origin, null, raw);
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // REST v3: /api/v3/...
      if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        const query = new Map<string, string>();
        url.searchParams.forEach((value, key) => query.set(key, value));
        let parsedBody: unknown = undefined;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              parsedBody = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = handleRest(store, method, restSegments, query, parsedBody, origin);
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      // Never crash the server on a bad request.
      try {
        sendJson(res, 500, { message: (e as Error).message ?? 'Internal Server Error' });
      } catch {
        // response already gone
      }
    }
  });

  return server;
}
