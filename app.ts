// The forge's HTTP server: a health probe, then the four surfaces — git smart
// HTTP, REST v3, GraphQL v4, and MCP — all sharing one in-memory store and one
// bearer token (MAKEFUN_SHOP_TOKEN). Anything else is GitHub's JSON 404.
// Every answer carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathOf, sendJson, type ForgeContext } from './http.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const prefix = randomBytes(4).toString('hex');
  let counter = 0;
  const ctx: ForgeContext = {
    store,
    token,
    nextRequestId: () => `${prefix}-${(counter += 1).toString(16).padStart(8, '0')}`,
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, ctx).catch((err: unknown) => {
      // A request must never take the server down or hang the client.
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }, ctx);
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  // Git smart HTTP never requires a token; the client sends one when it has it.
  if (await handleGit(req, res, ctx)) return;

  // REST v3 (includes the /api/v3 root), GraphQL v4, and MCP.
  if (await handleRest(req, res, ctx)) return;
  if (await handleGraphql(req, res, ctx)) return;
  if (await handleMcp(req, res, ctx)) return;

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, ctx);
}
