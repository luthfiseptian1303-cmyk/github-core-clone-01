// MCP over streamable HTTP: the /mcp surface — JSON-RPC 2.0, answered as
// application/json. The modern revision (2026-07-28) starts with
// server/discover (no handshake, no session); the legacy revision (2025-11-25
// or earlier) starts with initialize + notifications/initialized. tools/list
// is a fixed list (byte-identical across calls); tools/call acts on the same
// store as REST and GraphQL. A missing or wrong bearer token is 401; a
// non-JSON body is HTTP 400 with -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, nowIso, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { squashMerge } from './rest.ts';
import { isAuthorized, readBody, sendJson, type ForgeContext } from './http.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const LATEST_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        state: { type: 'string', description: 'The state of the issues to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        issue_number: { type: 'number', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        issue_number: { type: 'number', description: 'The number of the issue.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch with the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        state: { type: 'string', description: 'The state of the pull requests to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repositories',
    description: 'List repositories of the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { login: VIEWER_LOGIN, id: 1000 },
    private: repo.private,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: 1000 },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'open' ? 'open' : 'closed',
    user: { login: VIEWER_LOGIN, id: 1000 },
    head: { ref: pr.headRef, sha: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha },
    base: { ref: pr.baseRef, sha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha },
    merged: pr.merged,
    mergeable: true,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'open' ? null : pr.updatedAt,
    merged_at: pr.mergedAt,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/pull/${pr.number}`,
  };
}

/** Resolve owner/repo from tool arguments (owner+repo, or full_name). */
function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : null;
  let repoName = typeof args.repo === 'string' ? args.repo : null;
  if ((owner === null || repoName === null) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      repoName = parts[1];
    }
  }
  if (owner === null || repoName === null) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function textError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a tool by its (possibly server-prefixed) name. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const base = name.split('__').pop() as string;
  const tool = TOOLS.find((t) => t.name.toLowerCase() === base.toLowerCase());
  if (tool === undefined) {
    return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
  for (const required of tool.inputSchema.required) {
    // owner/repo may be supplied as full_name instead.
    if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string') continue;
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { result: textError(`Missing required argument: ${required}`) };
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', false);
      if ('error' in created) return { result: textError(created.error) };
      return { result: textResult(repoJson(created)) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      return { result: textResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { result: textResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: textResult(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'get_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : repo.issues.find((i) => i.number === number);
      if (issue === undefined) return { result: textError('Not Found') };
      return { result: textResult(issueJson(repo, issue)) };
    }
    case 'add_issue_comment': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : repo.issues.find((i) => i.number === number);
      if (issue === undefined) return { result: textError('Not Found') };
      const comment = { id: repo.nextCommentId++, body: String(args.body), createdAt: nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return { result: textResult({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.createdAt }) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const head = String(args.head);
      const base = String(args.base);
      if (head === base) {
        return { result: textError('head or base branch does not exist') };
      }
      const created = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in created) {
        return { result: textError(created.error) };
      }
      return { result: textResult(pullJson(repo, created)) };
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const prs = repo.pulls.filter((pr) => state === 'all' || pr.state === state);
      return { result: textResult(prs.map((pr) => pullJson(repo, pr))) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { result: textError('Not Found') };
      const number = asNumber(args.pull_number);
      const pr = number === null ? undefined : repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return { result: textError('Not Found') };
      if (pr.state !== 'open') return { result: textError('Pull request has already been merged') };
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return { result: textError('Not Found') };
      const merge = squashMerge(repo, headTip, baseTip, pr.baseRef);
      if (merge === null) return { result: textError('Merge conflict') };
      pr.state = 'merged';
      pr.merged = true;
      pr.mergeSha = merge.commitOid;
      pr.mergedAt = nowIso();
      pr.updatedAt = nowIso();
      return { result: textResult({ sha: merge.commitOid, merged: true, message: 'Pull request successfully merged' }) };
    }
    case 'list_repositories': {
      return { result: textResult(store.listViewerRepos().map((repo) => repoJson(repo))) };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Handle an MCP request. Returns true when the path was /mcp. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<boolean> {
  if (req.url === undefined || !req.url.startsWith('/mcp')) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' }, ctx);
    return true;
  }
  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { message: 'Requires authentication' }, ctx);
    return true;
  }

  const raw = await readBody(req);
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), ctx);
      return true;
    }
    request = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), ctx);
    return true;
  }

  const id = request.id;
  const method = request.method;
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no response body.
  if (id === undefined) {
    res.writeHead(202, { 'x-github-request-id': ctx.nextRequestId() });
    res.end();
    return true;
  }

  if (typeof method !== 'string') {
    sendJson(res, 200, rpcError(id, -32600, 'Invalid Request'), ctx);
    return true;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        protocolVersion: LATEST_VERSION,
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        capabilities: { tools: {} },
      }), ctx);
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const version = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }), ctx);
      return true;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}), ctx);
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }), ctx);
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') {
        sendJson(res, 200, rpcError(id, -32602, 'Invalid params: name is required'), ctx);
        return true;
      }
      const outcome = callTool(ctx.store, name, args);
      if ('error' in outcome) {
        const error = outcome.error as { code: number; message: string };
        sendJson(res, 200, rpcError(id, error.code, error.message), ctx);
        return true;
      }
      sendJson(res, 200, rpcResult(id, outcome.result), ctx);
      return true;
    }
    case 'resources/list': {
      sendJson(res, 200, rpcResult(id, { resources: [] }), ctx);
      return true;
    }
    case 'prompts/list': {
      sendJson(res, 200, rpcResult(id, { prompts: [] }), ctx);
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`), ctx);
      return true;
    }
  }
}
