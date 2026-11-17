// REST v3: the /api/v3 surface — repository, branch, commit, content, label,
// issue, comment, pull-request and search endpoints, plus the user, meta and
// root endpoints the protocol checks exercise. Every route needs a bearer
// token (a missing or wrong one is 401); a repository under any owner other
// than the token owner is 404, never 403. All answers are JSON and carry a
// non-empty X-GitHub-Request-Id.
//
// The merge rule here is a real three-way merge: the merge base is the nearest
// common ancestor of the head and base tips, so a pull request whose branches
// diverged before it was created is still detected as conflicting.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  authorLine,
  buildCommit,
  collectAncestors,
  diffFiles,
  filesFromTree,
  hashObject,
  isOid,
  nowIso,
  parseCommit,
  parseTree,
  sha1Hex,
  treeFromFiles,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  isAuthorized,
  parseJsonBody,
  pathOf,
  queryOf,
  readBody,
  requestOrigin,
  sendJson,
  sendNoContent,
  splitPath,
  type ForgeContext,
} from './http.ts';

// ---------------------------------------------------------------------------
// Three-way merge helpers (shared with GraphQL and MCP)
// ---------------------------------------------------------------------------

function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

/** The file map at a commit tip (empty when the tip is missing or not a commit). */
export function filesAtTip(repo: Repo, tip: string): Map<string, Buffer> {
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return filesFromTree(repo.objects, parseCommit(obj.data).tree);
}

/** The nearest common ancestor of two commits, or null when they share none. */
export function mergeBaseOid(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = collectAncestors(repo.objects, [b]);
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsB.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** True when a squash merge of head into base would apply cleanly. */
export function computeMergeable(repo: Repo, headTip: string, baseTip: string): boolean {
  const base = mergeBaseOid(repo, headTip, baseTip);
  if (base === null) return headTip === baseTip;
  const baseFiles = filesAtTip(repo, base);
  const headFiles = filesAtTip(repo, headTip);
  const targetFiles = filesAtTip(repo, baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
  for (const path of paths) {
    const oldContent = baseFiles.get(path);
    const headContent = headFiles.get(path);
    const targetContent = targetFiles.get(path);
    if (buffersEqual(oldContent, headContent)) continue;
    if (buffersEqual(oldContent, targetContent)) continue;
    if (!buffersEqual(headContent, targetContent)) return false;
  }
  return true;
}

/**
 * Squash-merge head into base: apply the head's changes (relative to the merge
 * base) onto the base tip's tree, commit the result on the base branch, and
 * move the base ref. Returns null when the merge conflicts.
 */
export function squashMerge(
  repo: Repo,
  headTip: string,
  baseTip: string,
  baseBranch: string,
): { treeOid: string; commitOid: string } | null {
  const base = mergeBaseOid(repo, headTip, baseTip);
  if (base === null) return null;
  const baseFiles = filesAtTip(repo, base);
  const headFiles = filesAtTip(repo, headTip);
  const targetFiles = filesAtTip(repo, baseTip);
  const merged = new Map(targetFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const oldContent = baseFiles.get(path);
    const headContent = headFiles.get(path);
    const targetContent = targetFiles.get(path);
    if (buffersEqual(oldContent, headContent)) continue;
    if (!buffersEqual(oldContent, targetContent) && !buffersEqual(headContent, targetContent)) return null;
    if (headContent === undefined) merged.delete(path);
    else merged.set(path, headContent);
  }
  const { rootOid, objects } = treeFromFiles(merged);
  for (const [oid, obj] of objects) repo.objects.set(oid, obj);
  const commitData = buildCommit({
    tree: rootOid,
    parents: [baseTip],
    author: authorLine(),
    committer: authorLine(),
    message: 'Squash merge\n',
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${baseBranch}`, commitOid);
  repo.updatedAt = nowIso();
  return { treeOid: rootOid, commitOid };
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: 'U_1000',
    avatar_url: 'https://avatars.githubusercontent.com/u/1000?v=4',
    gravatar_id: '',
    url: 'https://api.github.com/users/adaiversen',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: 'Ada Iversen',
    company: null,
    blog: '',
    location: null,
    email: null,
    hireable: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: nowIso(),
  };
}

function repoObject(repo: Repo, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  return {
    id: repo.databaseId,
    node_id: `R_${repo.databaseId}`,
    name: repo.name,
    full_name: fullName,
    owner: userObject(),
    private: repo.private,
    html_url: `https://github.com/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    archive_url: `${origin}/api/v3/repos/${fullName}/{archive_format}{/ref}`,
    assignees_url: `${origin}/api/v3/repos/${fullName}/assignees{/user}`,
    blobs_url: `${origin}/api/v3/repos/${fullName}/git/blobs{/sha}`,
    branches_url: `${origin}/api/v3/repos/${fullName}/branches{/branch}`,
    clone_url: `https://github.com/${fullName}.git`,
    collaborators_url: `${origin}/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    comments_url: `${origin}/api/v3/repos/${fullName}/comments{/number}`,
    commits_url: `${origin}/api/v3/repos/${fullName}/commits{/sha}`,
    compare_url: `${origin}/api/v3/repos/${fullName}/compare/{base}...{head}`,
    contents_url: `${origin}/api/v3/repos/${fullName}/contents/{+path}`,
    contributors_url: `${origin}/api/v3/repos/${fullName}/contributors`,
    deployments_url: `${origin}/api/v3/repos/${fullName}/deployments`,
    downloads_url: `${origin}/api/v3/repos/${fullName}/downloads`,
    events_url: `${origin}/api/v3/repos/${fullName}/events`,
    forks_url: `${origin}/api/v3/repos/${fullName}/forks`,
    git_commits_url: `${origin}/api/v3/repos/${fullName}/git/commits{/sha}`,
    git_refs_url: `${origin}/api/v3/repos/${fullName}/git/refs{/sha}`,
    git_tags_url: `${origin}/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_url: `git://github.com/${fullName}.git`,
    issue_comment_url: `${origin}/api/v3/repos/${fullName}/issues/comments{/number}`,
    issue_events_url: `${origin}/api/v3/repos/${fullName}/issues/events{/number}`,
    issues_url: `${origin}/api/v3/repos/${fullName}/issues{/number}`,
    keys_url: `${origin}/api/v3/repos/${fullName}/keys{/key_id}`,
    labels_url: `${origin}/api/v3/repos/${fullName}/labels{/name}`,
    languages_url: `${origin}/api/v3/repos/${fullName}/languages`,
    merges_url: `${origin}/api/v3/repos/${fullName}/merges`,
    milestones_url: `${origin}/api/v3/repos/${fullName}/milestones{/number}`,
    notifications_url: `${origin}/api/v3/repos/${fullName}/notifications{?since,all,participating}`,
    pulls_url: `${origin}/api/v3/repos/${fullName}/pulls{/number}`,
    releases_url: `${origin}/api/v3/repos/${fullName}/releases{/id}`,
    ssh_url: `git@github.com:${fullName}.git`,
    stargazers_url: `${origin}/api/v3/repos/${fullName}/stargazers`,
    statuses_url: `${origin}/api/v3/repos/${fullName}/statuses/{sha}`,
    subscribers_url: `${origin}/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `${origin}/api/v3/repos/${fullName}/subscription`,
    tags_url: `${origin}/api/v3/repos/${fullName}/tags`,
    teams_url: `${origin}/api/v3/repos/${fullName}/teams`,
    trees_url: `${origin}/api/v3/repos/${fullName}/git/trees{/sha}`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    pushed_at: repo.updatedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    subscribers_count: 0,
    network_count: 0,
  };
}

/** A label's REST id is a stable hash of its name (the store keeps no label ids). */
function labelId(repo: Repo, name: string): number {
  return parseInt(sha1Hex(`${repo.databaseId}:${name}`).slice(0, 8), 16);
}

function labelObject(repo: Repo, label: Label, origin: string): Record<string, unknown> {
  return {
    id: labelId(repo, label.name),
    node_id: `L_${labelId(repo, label.name)}`,
    url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

function issueObject(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${fullName}`,
    labels_url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `${origin}/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObject(),
    labels: issue.labels.map((label) => labelObject(repo, label, origin)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
  };
}

function commentObject(repo: Repo, comment: { id: number; body: string; createdAt: string }, issueNumber: number, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: `${origin}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObject(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function pullObject(repo: Repo, pr: Pull, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: `PR_${pr.id}`,
    url: `${origin}/api/v3/repos/${fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${fullName}/pull/${pr.number}`,
    diff_url: `https://github.com/${fullName}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${fullName}/pull/${pr.number}.patch`,
    issue_url: `${origin}/api/v3/repos/${fullName}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state === 'open' ? 'open' : 'closed',
    locked: false,
    title: pr.title,
    user: userObject(),
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'open' ? null : pr.updatedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${origin}/api/v3/repos/${fullName}/pulls/${pr.number}/commits`,
    review_comments_url: `${origin}/api/v3/repos/${fullName}/pulls/${pr.number}/comments`,
    review_comment_url: `${origin}/api/v3/repos/${fullName}/pulls/comments{/number}`,
    comments_url: `${origin}/api/v3/repos/${fullName}/issues/${pr.number}/comments`,
    statuses_url: `${origin}/api/v3/repos/${fullName}/statuses/${headSha}`,
    head: {
      label: `${VIEWER_LOGIN}:${pr.headRef}`,
      ref: pr.headRef,
      sha: headSha,
      user: userObject(),
      repo: repoObject(repo, origin),
    },
    base: {
      label: `${VIEWER_LOGIN}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: baseSha,
      user: userObject(),
      repo: repoObject(repo, origin),
    },
    author_association: 'OWNER',
    auto_merge: null,
    merged: pr.merged,
    mergeable: computeMergeable(repo, headSha, baseSha),
    rebaseable: computeMergeable(repo, headSha, baseSha),
    mergeable_state: computeMergeable(repo, headSha, baseSha) ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** Split a "Name <email> ts tz" identity line into its parts. */
function identityParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: line, email: '', date: nowIso() };
  return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
}

function commitObject(repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const author = identityParts(parsed.author);
  const committer = identityParts(parsed.committer);
  return {
    sha,
    node_id: `CM_${sha}`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree, url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/trees/${parsed.tree}` },
      url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/commit/${sha}`,
    comments_url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${sha}/comments`,
    author: userObject(),
    committer: userObject(),
    parents: parsed.parents.map((parent) => ({
      sha: parent,
      url: `${origin}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${parent}`,
      html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/commit/${parent}`,
    })),
  };
}

function fileObject(repo: Repo, path: string, oid: string, content: Buffer, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: oid,
    url: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: `${origin}/api/v3/repos/${fullName}/git/blobs/${oid}`,
    html_url: `https://github.com/${fullName}/blob/main/${path}`,
    download_url: `https://raw.githubusercontent.com/${fullName}/main/${path}`,
    _links: {
      git: `${origin}/api/v3/repos/${fullName}/git/blobs/${oid}`,
      self: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
      html: `https://github.com/${fullName}/blob/main/${path}`,
    },
  };
}

function dirEntryObject(repo: Repo, path: string, entry: { name: string; type: 'file' | 'dir'; oid: string }, origin: string): Record<string, unknown> {
  const fullName = `${VIEWER_LOGIN}/${repo.name}`;
  const isFile = entry.type === 'file';
  const size = isFile ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0;
  return {
    type: entry.type,
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: isFile
      ? `${origin}/api/v3/repos/${fullName}/git/blobs/${entry.oid}`
      : `${origin}/api/v3/repos/${fullName}/git/trees/${entry.oid}`,
    html_url: isFile
      ? `https://github.com/${fullName}/blob/main/${path}`
      : `https://github.com/${fullName}/tree/main/${path}`,
    download_url: isFile ? `https://raw.githubusercontent.com/${fullName}/main/${path}` : null,
    _links: {
      git: isFile
        ? `${origin}/api/v3/repos/${fullName}/git/blobs/${entry.oid}`
        : `${origin}/api/v3/repos/${fullName}/git/trees/${entry.oid}`,
      self: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
      html: isFile
        ? `https://github.com/${fullName}/blob/main/${path}`
        : `https://github.com/${fullName}/tree/main/${path}`,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The branch a contents `ref` parameter names (default: main). */
function branchOf(ref: string): string {
  if (ref === 'main') return 'main';
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return ref;
}

/** Find a directory's tree oid by walking the tree path. */
function treeOidAtPath(repo: Repo, treeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter(Boolean);
  let current = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Handle a REST request. Returns true when the path was a REST path. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const origin = requestOrigin(req);
  const segments = splitPath(path); // ['api','v3',...]
  const rest = segments.slice(2);
  const store: Store = ctx.store;

  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { message: 'Requires authentication' }, ctx);
    return true;
  }

  try {
    // GET /api/v3/ — the root; carries the OAuth scopes header.
    if (method === 'GET' && rest.length === 0) {
      sendJson(res, 200, { current_user_url: `${origin}/api/v3/user` }, ctx, {
        'x-oauth-scopes': 'repo, read:org',
      });
      return true;
    }

    // GET /api/v3/meta
    if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
      sendJson(res, 200, {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        ssh_keys: [],
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
        installed_version: '1.0.0',
      }, ctx);
      return true;
    }

    // GET /api/v3/user
    if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
      sendJson(res, 200, userObject(), ctx);
      return true;
    }

    // GET /api/v3/user/keys, /user/emails, /user/orgs
    if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'keys') {
      sendJson(res, 200, [], ctx);
      return true;
    }
    if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'emails') {
      sendJson(res, 200, [{ email: 'adaiversen@users.noreply.github.com', primary: true, verified: true, visibility: 'private' }], ctx);
      return true;
    }
    if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'orgs') {
      sendJson(res, 200, [], ctx);
      return true;
    }

    // GET /api/v3/user/repos (list, paginated) and POST /api/v3/user/repos (create)
    if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const query = queryOf(req);
        const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
        const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
        const all = store.listViewerRepos();
        const total = all.length;
        const start = (page - 1) * perPage;
        const items = all.slice(start, start + perPage).map((repo) => repoObject(repo, origin));
        const extra: Record<string, string> = {};
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        if (page < totalPages) {
          const base = `${origin}/api/v3/user/repos?per_page=${perPage}`;
          extra.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${totalPages}>; rel="last"`;
        }
        sendJson(res, 200, items, ctx, extra);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = asString(body.name);
        if (name === null || name.trim() === '') {
          sendJson(res, 422, { message: 'name is required', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }, ctx);
          return true;
        }
        const created = store.createRepo(name, asString(body.description) ?? '', body.private === true);
        if ('error' in created) {
          sendJson(res, 422, { message: created.error, errors: [{ resource: 'Repository', field: 'name', code: 'custom' }] }, ctx);
          return true;
        }
        sendJson(res, 201, repoObject(created, origin), ctx);
        return true;
      }
    }

    // GET /api/v3/search/repositories
    if (method === 'GET' && rest.length === 2 && rest[0] === 'search' && rest[1] === 'repositories') {
      const query = queryOf(req);
      const q = (query.get('q') ?? '').toLowerCase();
      const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const matched = store
        .listViewerRepos()
        .filter((repo) => q === '' || repo.name.toLowerCase().includes(q) || (repo.description ?? '').toLowerCase().includes(q) || VIEWER_LOGIN.toLowerCase().includes(q));
      const start = (page - 1) * perPage;
      sendJson(res, 200, {
        total_count: matched.length,
        incomplete_results: false,
        items: matched.slice(start, start + perPage).map((repo) => repoObject(repo, origin)),
      }, ctx);
      return true;
    }

    // Everything below is /api/v3/repos/{owner}/{repo}/...
    if (rest.length < 3 || rest[0] !== 'repos') {
      sendJson(res, 404, { message: 'Not Found' }, ctx);
      return true;
    }
    const owner = rest[1];
    const repoName = rest[2];
    const tail = rest.slice(3);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' }, ctx);
      return true;
    }

    // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoObject(repo, origin), ctx);
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const description = asString(body.description);
        if (description !== null) {
          repo.description = description;
          repo.updatedAt = nowIso();
        }
        sendJson(res, 200, repoObject(repo, origin), ctx);
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        sendNoContent(res, ctx);
        return true;
      }
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: parsed.error }, ctx);
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === null || sha === null || !ref.startsWith('refs/') || !isOid(sha)) {
        sendJson(res, 422, { message: 'ref and sha are required', errors: [] }, ctx);
        return true;
      }
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendJson(res, 422, { message: 'Object does not exist', errors: [] }, ctx);
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists', errors: [{ resource: 'Reference', field: 'ref', code: 'custom' }] }, ctx);
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, {
        ref,
        node_id: `REF_${ref}`,
        url: `${origin}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      }, ctx);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: oid, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${oid}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches, ctx);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits?sha=<ref>
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const query = queryOf(req);
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) {
        sendJson(res, 404, { message: 'Not Found' }, ctx);
        return true;
      }
      const commits = store
        .listCommits(repo, tip)
        .map(({ sha }) => commitObject(repo, sha, origin))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      sendJson(res, 200, commits, ctx);
      return true;
    }

    // /api/v3/repos/{o}/{r}/contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const query = queryOf(req);
      const ref = query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = store.resolveRef(repo, ref);
        if (tip === null) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const files = filesAtTip(repo, tip);
        const content = files.get(contentPath);
        if (content !== undefined) {
          sendJson(res, 200, fileObject(repo, contentPath, hashObject('blob', content), content, origin), ctx);
          return true;
        }
        // A directory: the entries directly under this path.
        const prefix = contentPath === '' ? '' : `${contentPath}/`;
        const children = new Map<string, { name: string; type: 'file' | 'dir'; oid: string }>();
        for (const [path, data] of files) {
          if (!path.startsWith(prefix)) continue;
          const remainder = path.slice(prefix.length);
          const slash = remainder.indexOf('/');
          if (slash === -1) {
            children.set(remainder, { name: remainder, type: 'file', oid: hashObject('blob', data) });
          } else {
            const dirName = remainder.slice(0, slash);
            if (!children.has(dirName)) {
              const tipObj = repo.objects.get(tip);
              const treeOid = tipObj !== undefined && tipObj.type === 'commit' ? parseCommit(tipObj.data).tree : null;
              const dirOid = treeOid !== null ? treeOidAtPath(repo, treeOid, `${prefix}${dirName}`) : null;
              children.set(dirName, { name: dirName, type: 'dir', oid: dirOid ?? '' });
            }
          }
        }
        if (children.size === 0) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const entries = [...children.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((entry) => dirEntryObject(repo, `${prefix}${entry.name}`, entry, origin));
        sendJson(res, 200, entries, ctx);
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const contentB64 = asString(body.content);
        if (contentB64 === null) {
          sendJson(res, 422, { message: 'content is required', errors: [] }, ctx);
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 400, { message: 'content is not valid base64' }, ctx);
          return true;
        }
        // GitHub's PUT /contents takes the target branch in the JSON body
        // (`body.branch`); the query `branch`/`ref` is a fallback. Reading
        // only `ref` sent every branch commit to the default branch.
        const writeBranch = branchOf(asString(body.branch) ?? query.get('branch') ?? ref);
        const tip = store.resolveRef(repo, writeBranch);
        const files = tip !== null ? filesAtTip(repo, tip) : new Map<string, Buffer>();
        const existing = files.get(contentPath);
        const isUpdate = existing !== undefined;
        if (isUpdate) {
          const expectedSha = asString(body.sha);
          if (expectedSha !== null && expectedSha !== hashObject('blob', existing)) {
            sendJson(res, 409, { message: 'sha does not match the current blob' }, ctx);
            return true;
          }
        }
        const newFiles = new Map(files);
        newFiles.set(contentPath, content);
        const message = asString(body.message) ?? (isUpdate ? `Update ${contentPath}` : `Create ${contentPath}`);
        const commitOid = store.createContentsCommit(repo, writeBranch, message, newFiles);
        const newBlobOid = hashObject('blob', content);
        sendJson(res, isUpdate ? 200 : 201, {
          content: fileObject(repo, contentPath, newBlobOid, content, origin),
          commit: { sha: commitOid, node_id: `CM_${commitOid}`, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${commitOid}`, html_url: `https://github.com/${owner}/${repoName}/commit/${commitOid}`, message },
        }, ctx);
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const writeBranch = branchOf(asString(body.branch) ?? query.get('branch') ?? ref);
        const tip = store.resolveRef(repo, writeBranch);
        if (tip === null) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const files = filesAtTip(repo, tip);
        const existing = files.get(contentPath);
        if (existing === undefined) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const expectedSha = asString(body.sha);
        if (expectedSha !== null && expectedSha !== hashObject('blob', existing)) {
          sendJson(res, 409, { message: 'sha does not match the current blob' }, ctx);
          return true;
        }
        const newFiles = new Map(files);
        newFiles.delete(contentPath);
        const message = asString(body.message) ?? `Delete ${contentPath}`;
        const commitOid = store.createContentsCommit(repo, writeBranch, message, newFiles);
        sendJson(res, 200, {
          commit: { sha: commitOid, node_id: `CM_${commitOid}`, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${commitOid}`, html_url: `https://github.com/${owner}/${repoName}/commit/${commitOid}`, message },
        }, ctx);
        return true;
      }
    }

    // POST /api/v3/repos/{o}/{r}/labels
    if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: parsed.error }, ctx);
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = asString(body.name);
      if (name === null || name.trim() === '') {
        sendJson(res, 422, { message: 'name is required', errors: [] }, ctx);
        return true;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists', errors: [] }, ctx);
        return true;
      }
      const label: Label = { name, color: asString(body.color) ?? 'ededed' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelObject(repo, label, origin), ctx);
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/issues and GET /api/v3/repos/{o}/{r}/issues
    if (tail.length === 1 && tail[0] === 'issues') {
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        if (title === null || title.trim() === '') {
          sendJson(res, 422, { message: 'title is required', errors: [] }, ctx);
          return true;
        }
        const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendJson(res, 422, { message: `Label does not exist: ${labelName}`, errors: [] }, ctx);
            return true;
          }
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, asString(body.body) ?? '', labels);
        sendJson(res, 201, issueObject(repo, issue, origin), ctx);
        return true;
      }
      if (method === 'GET') {
        const query = queryOf(req);
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        const key = (issue: Issue): string | number => (sort === 'updated' ? issue.updatedAt : issue.seq);
        issues = [...issues].sort((a, b) => {
          const ka = key(a);
          const kb = key(b);
          const diff = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
          const total = diff !== 0 ? diff : a.number - b.number;
          return direction === 'asc' ? total : -total;
        });
        sendJson(res, 200, issues.map((issue) => issueObject(repo, issue, origin)), ctx);
        return true;
      }
    }

    // GET / PATCH /api/v3/repos/{o}/{r}/issues/{n}
    if (tail.length === 2 && tail[0] === 'issues') {
      const number = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' }, ctx);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueObject(repo, issue, origin), ctx);
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(body.title);
        if (title !== null) issue.title = title;
        const bodyText = asString(body.body);
        if (bodyText !== null) issue.body = bodyText;
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueObject(repo, issue, origin), ctx);
        return true;
      }
    }

    // POST / GET /api/v3/repos/{o}/{r}/issues/{n}/comments
    if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
      const number = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' }, ctx);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.error }, ctx);
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const text = asString(body.body);
        if (text === null || text.trim() === '') {
          sendJson(res, 422, { message: 'body is required', errors: [] }, ctx);
          return true;
        }
        const comment = { id: repo.nextCommentId++, body: text, createdAt: nowIso() };
        issue.comments.push(comment);
        issue.updatedAt = nowIso();
        sendJson(res, 201, commentObject(repo, comment, issue.number, origin), ctx);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentObject(repo, comment, issue.number, origin)), ctx);
        return true;
      }
    }

    // GET /api/v3/repos/{o}/{r}/pulls (list; ?state=open|closed|all, default open)
    if (method === 'GET' && tail.length === 1 && tail[0] === 'pulls') {
      const query = queryOf(req);
      const state = query.get('state') ?? 'open';
      const pulls = [...repo.pulls]
        .filter((pr) => (state === 'all' ? true : state === 'closed' ? pr.state !== 'open' : pr.state === 'open'))
        .sort((a, b) => b.number - a.number)
        .map((pr) => pullObject(repo, pr, origin));
      sendJson(res, 200, pulls, ctx);
      return true;
    }

    // POST /api/v3/repos/{o}/{r}/pulls
    if (method === 'POST' && tail.length === 1 && tail[0] === 'pulls') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: parsed.error }, ctx);
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (title === null || head === null || base === null) {
        sendJson(res, 422, { message: 'title, head and base are required', errors: [] }, ctx);
        return true;
      }
      if (head === base) {
        sendJson(res, 422, { message: 'No commits between head and base', errors: [] }, ctx);
        return true;
      }
      const created = store.createPull(repo, title, asString(body.body) ?? '', head, base);
      if ('error' in created) {
        sendJson(res, 422, { message: created.error, errors: [] }, ctx);
        return true;
      }
      sendJson(res, 201, pullObject(repo, created, origin), ctx);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/pulls/{n} and /pulls/{n}/files and PUT .../merge
    if (tail.length >= 2 && tail[0] === 'pulls') {
      const number = parseInt(tail[1], 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) {
        sendJson(res, 404, { message: 'Not Found' }, ctx);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        sendJson(res, 200, pullObject(repo, pr, origin), ctx);
        return true;
      }
      if (method === 'GET' && tail.length === 3 && tail[2] === 'files') {
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const baseFiles = filesAtTip(repo, baseTip);
        const headFiles = filesAtTip(repo, headTip);
        const changes = diffFiles(baseFiles, headFiles);
        const files = changes.map((change) => {
          const oldContent = baseFiles.get(change.path);
          const newContent = headFiles.get(change.path);
          const sha =
            newContent !== undefined
              ? hashObject('blob', newContent)
              : oldContent !== undefined
                ? hashObject('blob', oldContent)
                : '';
          return {
            sha,
            filename: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
            blob_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${sha}`,
            raw_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${pr.headRef}/${change.path}`,
            contents_url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${change.path}?ref=${pr.headRef}`,
            patch: '',
          };
        });
        sendJson(res, 200, files, ctx);
        return true;
      }
      if (method === 'PUT' && tail.length === 3 && tail[2] === 'merge') {
        if (pr.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request has already been merged' }, ctx);
          return true;
        }
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 404, { message: 'Not Found' }, ctx);
          return true;
        }
        const merge = squashMerge(repo, headTip, baseTip, pr.baseRef);
        if (merge === null) {
          sendJson(res, 405, { message: 'Merge conflict' }, ctx);
          return true;
        }
        pr.state = 'merged';
        pr.merged = true;
        pr.mergeSha = merge.commitOid;
        pr.mergedAt = nowIso();
        pr.updatedAt = nowIso();
        sendJson(res, 200, {
          sha: merge.commitOid,
          merged: true,
          message: 'Pull request successfully merged',
        }, ctx);
        return true;
      }
    }

    sendJson(res, 404, { message: 'Not Found' }, ctx);
    return true;
  } catch (err) {
    // A malformed request must never take the server down.
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }, ctx);
    }
    return true;
  }
}
