/**
 * 127.0.0.1 전용 HTTP 서버. 요청마다 Host → Origin → CORS → 라우팅 순서로 처리한다.
 * /mcp 는 무상태 Streamable HTTP(요청마다 새 McpServer + transport).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuditLog } from './audit.js';
import { PORT_RANGE_END, type ConfigStore } from './config.js';
import { createMcpServer } from './mcp.js';
import type { Confirmer } from './policy/confirmer.js';
import { ConfirmationGate } from './policy/gate.js';
import { isAllowedHost, isAllowedOrigin } from './security/origin.js';
import { hashToken, PairingManager } from './security/pairing.js';
import { RateLimiter } from './security/rateLimit.js';
import { buildDefaultTools } from './tools/index.js';
import type { ToolDef } from './tools/types.js';
import { AGENT_VERSION } from './version.js';

export interface AgentOptions {
  store: ConfigStore;
  confirmer: Confirmer;
  dev?: boolean;
  tools?: ToolDef[];
  auditFile?: string;
  confirmTimeoutMs?: number;
}

export interface RunningAgent {
  port: number;
  pairing: PairingManager;
  close(): Promise<void>;
}

const BODY_MAX_BYTES = 2 * 1024 * 1024;
const ALLOW_HEADERS = 'authorization, content-type, mcp-protocol-version, mcp-session-id';

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function listen(server: Server, start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && port < PORT_RANGE_END) attempt(port + 1);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    attempt(start);
  });
}

export async function startAgent(opts: AgentOptions): Promise<RunningAgent> {
  const { store } = opts;
  const dev = opts.dev === true;
  const tools = opts.tools ?? buildDefaultTools();
  const pairing = new PairingManager(store);
  const gate = new ConfirmationGate(store, opts.confirmer, opts.confirmTimeoutMs);
  const audit = new AuditLog(opts.auditFile ?? path.join(store.dir, 'audit.log'));
  const limiter = new RateLimiter(20, 1000);
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, port)) return sendJson(res, 403, { error: 'forbidden_host' });
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!origin || !isAllowedOrigin(origin, dev)) return sendJson(res, 403, { error: 'forbidden_origin' });

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      return sendJson(res, 204);
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { name: 'aeyes-local-agent', version: AGENT_VERSION, paired: store.get().pairings.length > 0 });
    }

    if (pathname === '/pair' && req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(await readBody(req));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return sendJson(res, 400, { error: 'invalid_json' });
        body = value as Record<string, unknown>;
      } catch (error) {
        if (error instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'too_large' });
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      const result = await pairing.redeem({
        code: String(body.code ?? ''),
        accountLabel: String(body.accountLabel ?? ''),
        browserLabel: String(body.browserLabel ?? ''),
      });
      if (result.ok) return sendJson(res, 200, { token: result.token });
      return sendJson(res, result.reason === 'locked' ? 423 : 401, { error: result.reason });
    }

    const token = bearer(req);
    const record = token ? pairing.verify(token) : null;

    if (pathname === '/pair' && req.method === 'DELETE') {
      if (!record) return sendJson(res, 401, { error: 'unauthorized' });
      await pairing.revoke(record.id);
      return sendJson(res, 204);
    }

    if (pathname === '/mcp') {
      if (!record || !token) return sendJson(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!limiter.allow(hashToken(token))) return sendJson(res, 429, { error: 'rate_limited' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'too_large' });
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      void pairing.touch(record.id).catch(() => undefined);
      const mcp = createMcpServer(tools, {
        allowedDirs: store.get().allowedDirs,
        deniedDirs: [store.dir],
        gate,
        audit,
        identity: { origin, pairingId: record.id, accountLabel: record.accountLabel },
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    return sendJson(res, 404, { error: 'not_found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[aeyes-local-agent]', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  port = await listen(server, store.get().port);

  return {
    port,
    pairing,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
