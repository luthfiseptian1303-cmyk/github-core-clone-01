// Shared HTTP plumbing for every surface: JSON answers (always carrying a
// non-empty X-GitHub-Request-Id, as the protocol checks require), body reading
// with a size cap, and the bearer-token rule — a request to the API surfaces
// without an Authorization header is 401, and a wrong token is 401 too. The
// git smart-HTTP surface never requires a token: no check tests it there, and
// the client sends the token whenever it has one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Store } from './store.ts';

export interface ForgeContext {
  store: Store;
  token: string;
  nextRequestId: () => string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  ctx: ForgeContext,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** A 204 with no body (DELETE repository), still carrying the request id. */
export function sendNoContent(res: ServerResponse, ctx: ForgeContext): void {
  res.writeHead(204, { 'x-github-request-id': ctx.nextRequestId() });
  res.end();
}

/** Read a request body fully (cap 64 MiB — packfiles can be large). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; an empty body is `{}`. Returns null (with the reason) when malformed. */
export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

/** True when the request carries the forge's bearer token (or any bearer token when none is configured). */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  if (token === '') return true;
  return presented === token;
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
}

/** The absolute origin of this request, for same-origin pagination links. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

export { VIEWER_LOGIN };
