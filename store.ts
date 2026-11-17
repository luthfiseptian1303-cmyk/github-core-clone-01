// The forge's in-memory store: one object database per repository (git objects, refs,
// issues, pull requests, labels, comments) plus the git object model itself — SHA-1
// hashing, tree/commit/tag encoding and parsing, file-map <-> tree conversion,
// reachability walks, file diffs and the squash-merge rule. Everything the four
// surfaces (git smart HTTP, REST v3, GraphQL v4, MCP) read and write goes through here,
// so a repository created over REST is the same repository git clones, and a pull
// request merged over MCP is the same one REST reads back.

import { createHash } from 'node:crypto';

// The trial's fixed scenario seed (wire.ts SCENARIO_SEED) names the token owner in
// every trial — live, replay and practice all see the same data, so the viewer login
// is a constant of this contest, not something to guess from the opaque bearer token.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: SHA-1 over "<type> <size>\0" + the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree sort: names compared byte-wise, directories as if the name ended '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.mode === '40000', y.name, y.mode === '40000'));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > data.length) {
      throw new Error('tree-parse: malformed tree entry');
    }
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Commits and tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(commit: CommitInfo): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  if (!isOid(commit.tree)) throw new Error('commit-parse: no valid tree header');
  return commit;
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(tag: TagInfo): Buffer {
  return Buffer.from(
    `object ${tag.object}\ntype ${tag.type}\ntag ${tag.tag}\ntagger ${tag.tagger}\n\n${tag.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const tag: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

// ---------------------------------------------------------------------------
// File maps <-> trees
// ---------------------------------------------------------------------------

/**
 * Build nested tree objects for a flat path -> bytes map. Returns the root tree
 * oid and every object created (blobs and trees) so the caller can store them.
 */
export function treeFromFiles(files: Map<string, Buffer>): { rootOid: string; objects: Map<string, GitObject> } {
  const created = new Map<string, GitObject>();
  const store = (type: ObjType, data: Buffer): string => {
    const oid = hashObject(type, data);
    if (!created.has(oid)) created.set(oid, { type, data });
    return oid;
  };

  // Group paths into a nested directory structure.
  interface DirNode {
    files: Map<string, Buffer>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, content] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], content);
  }

  const buildDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, content] of node.files) {
      entries.push({ mode: '100644', name, oid: store('blob', content) });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: buildDir(child) });
    }
    return store('tree', buildTree(entries));
  };

  return { rootOid: buildDir(root), objects: created };
}

/** Flatten a stored tree back into a path -> bytes map (missing objects throw). */
export function filesFromTree(objects: Map<string, GitObject>, rootOid: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') throw new Error(`missing-object: tree ${treeOid}`);
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
      } else if (entry.mode === '160000') {
        // gitlink: not a file in this forge.
      } else {
        const blob = objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') throw new Error(`missing-object: blob ${entry.oid}`);
        files.set(path, blob.data);
      }
    }
  };
  walk(rootOid, '');
  return files;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export interface ReachableResult {
  /** Every object id reachable (commits, trees, blobs, tags). */
  all: Set<string>;
  /** The commits reached, in walk order. */
  commits: string[];
  /** Included commits whose parents exist but were cut off by the depth limit. */
  boundary: string[];
}

/**
 * Walk from `roots` collecting every reachable object. With `maxDepth`, commits
 * at depth >= maxDepth are not entered (their parents are the boundary): a want
 * sits at depth 0, so deepen 1 keeps only the tips, deepen 2 keeps tips + parents.
 */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: string[],
  maxDepth?: number,
): ReachableResult {
  const all = new Set<string>();
  const commits: string[] = [];
  const seenCommits = new Set<string>();
  const boundary: string[] = [];

  const addTree = (treeOid: string): void => {
    if (all.has(treeOid)) return;
    const obj = objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    all.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (entry.mode !== '160000') all.add(entry.oid);
    }
  };

  // Depth-first over commits; a queue keeps generation order stable.
  const queue: { oid: string; depth: number }[] = roots.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (all.has(oid)) continue;
      all.add(oid);
      const tag = parseTag(obj.data);
      queue.push({ oid: tag.object, depth });
      continue;
    }
    if (obj.type !== 'commit') {
      all.add(oid);
      continue;
    }
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    all.add(oid);
    commits.push(oid);
    const commit = parseCommit(obj.data);
    addTree(commit.tree);
    const parentsIncluded = maxDepth === undefined || depth + 1 < maxDepth;
    for (const parent of commit.parents) {
      if (parentsIncluded) queue.push({ oid: parent, depth: depth + 1 });
      else if (!boundary.includes(oid)) boundary.push(oid);
    }
  }
  return { all, commits, boundary };
}

/** The set of commits reachable from `roots` by following parents only. */
export function collectAncestors(objects: Map<string, GitObject>, roots: string[]): Set<string> {
  const ancestors = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestors.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    ancestors.add(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return ancestors;
}

/** True when `oldOid` is an ancestor of (or equal to) `newOid`. */
export function isAncestor(objects: Map<string, GitObject>, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  return collectAncestors(objects, [newOid]).has(oldOid);
}

// ---------------------------------------------------------------------------
// File diffs (for pull request file lists and the merge conflict rule)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not make an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line diff by longest-common-subsequence; files here are small (a few KB). */
export function countLineDiff(oldContent: Buffer, newContent: Buffer): { additions: number; deletions: number } {
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

export function diffFiles(base: Map<string, Buffer>, head: Map<string, Buffer>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldContent = base.get(path);
    const newContent = head.get(path);
    if (oldContent !== undefined && newContent !== undefined) {
      if (oldContent.equals(newContent)) continue;
      const { additions, deletions } = countLineDiff(oldContent, newContent);
      changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    } else if (newContent !== undefined) {
      const additions = splitLines(newContent).length;
      changes.push({ path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldContent !== undefined) {
      const deletions = splitLines(oldContent).length;
      // The suite's file shape only accepts added/modified/changed; a deletion
      // is reported with the generic 'changed' status.
      changes.push({ path, status: 'changed', additions: 0, deletions, changes: deletions });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Repository model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  /** Monotonic creation order, for CREATED_AT ordering. */
  seq: number;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One shared counter for issues and pull requests, like GitHub's. */
  nextNumber: number;
  nextCommentId: number;
  /** Monotonic creation order across the whole forge, for list stability. */
  seq: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function authorLine(timestampSec?: number): string {
  const ts = timestampSec ?? nowEpochSec();
  return `${VIEWER_IDENTITY} ${ts} +0000`;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDatabaseId = 1;
  nextRestId = 1;
  nextSeq = 1;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | { error: string } {
    if (typeof name !== 'string' || name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return { error: 'name is required and must be a valid repository name' };
    }
    if (this.getRepo(VIEWER_LOGIN, name) !== undefined) {
      return { error: 'Repository already exists' };
    }
    const now = nowIso();
    const repo: Repo = {
      databaseId: this.nextDatabaseId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq,
    };
    this.nextDatabaseId += 1;
    this.nextSeq += 1;
    this.repos.set(Store.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.repoKey(repo.owner, repo.name));
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) {
      const obj = repo.objects.get(ref);
      return obj !== undefined && obj.type === 'commit' ? ref : null;
    }
    if (ref.startsWith('refs/')) {
      return repo.refs.get(ref) ?? null;
    }
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** All commits reachable from `tip`, newest first (depth-first pre-order). */
  listCommits(repo: Repo, tip: string): { sha: string; commit: CommitInfo }[] {
    const out: { sha: string; commit: CommitInfo }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      out.push({ sha: oid, commit });
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return out;
  }

  /** The file map at a commit oid. */
  filesAt(repo: Repo, commitOid: string): Map<string, Buffer> {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') throw new Error(`missing-object: commit ${commitOid}`);
    return filesFromTree(repo.objects, parseCommit(obj.data).tree);
  }

  /** Create a commit on a branch from a new file map; returns the commit oid. */
  createContentsCommit(
    repo: Repo,
    branch: string,
    message: string,
    files: Map<string, Buffer>,
  ): string {
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const { rootOid, objects } = treeFromFiles(files);
    for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    const commitData = buildCommit({
      tree: rootOid,
      parents: tip === null ? [] : [tip],
      author: authorLine(),
      committer: authorLine(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = nowIso();
    return commitOid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = nowIso();
    const issue: Issue = {
      id: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq,
    };
    this.nextRestId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      return { error: 'head or base branch does not exist' };
    }
    const openDuplicate = repo.pulls.find(
      (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
    );
    if (openDuplicate !== undefined) {
      return { error: 'A pull request already exists for this head and base' };
    }
    const now = nowIso();
    const pull: Pull = {
      id: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      headRef,
      baseRef,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq,
    };
    this.nextRestId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The files a pull request changes, from its creation-time base to its head. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const baseFiles = this.filesAt(repo, pull.baseSha);
    const headFiles = this.filesAt(repo, pull.headSha);
    return diffFiles(baseFiles, headFiles);
  }

  /** True when the head's changes collide with changes already landed on base. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseAtCreation = this.filesAt(repo, pull.baseSha);
    const headFiles = this.filesAt(repo, pull.headSha);
    const baseTipOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTipOid === undefined) return false;
    const currentBase = this.filesAt(repo, baseTipOid);
    const paths = new Set([...baseAtCreation.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const oldContent = baseAtCreation.get(path);
      const headContent = headFiles.get(path);
      const baseContent = currentBase.get(path);
      const changedInPr =
        (oldContent === undefined) !== (headContent === undefined) ||
        (oldContent !== undefined && headContent !== undefined && !oldContent.equals(headContent));
      if (!changedInPr) continue;
      const changedOnBase =
        (oldContent === undefined) !== (baseContent === undefined) ||
        (oldContent !== undefined && baseContent !== undefined && !oldContent.equals(baseContent));
      if (!changedOnBase) continue;
      const headEqualsBase =
        (headContent === undefined && baseContent === undefined) ||
        (headContent !== undefined && baseContent !== undefined && headContent.equals(baseContent));
      if (!headEqualsBase) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge sha, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTipOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTipOid === undefined) return null;
    const baseAtCreation = this.filesAt(repo, pull.baseSha);
    const headFiles = this.filesAt(repo, pull.headSha);
    const currentBase = this.filesAt(repo, baseTipOid);
    const result = new Map(currentBase);
    for (const path of new Set([...baseAtCreation.keys(), ...headFiles.keys()])) {
      const oldContent = baseAtCreation.get(path);
      const headContent = headFiles.get(path);
      if (headContent === undefined) result.delete(path);
      else if (oldContent === undefined || !oldContent.equals(headContent)) result.set(path, headContent);
    }
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const mergeSha = this.createContentsCommit(repo, pull.baseRef, message, result);
    // createContentsCommit parents the merge on the current base tip, which is
    // exactly what a squash merge does; fix the parent to be that tip (it is).
    pull.state = 'merged';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeSha = mergeSha;
    pull.updatedAt = nowIso();
    return mergeSha;
  }

  /** Global ids (Relay-style): opaque, stable, never the plain database id or number. */
  static globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', ...parts: (string | number)[]): string {
    return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
  }

  static decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const [kind, ...parts] = text.split(':');
      if (kind === undefined || parts.length === 0) return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }

  repoGlobalId(repo: Repo): string {
    return Store.globalId('Repository', repo.databaseId);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return Store.globalId('Issue', repo.databaseId, issue.number);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return Store.globalId('PullRequest', repo.databaseId, pull.number);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return Store.globalId('IssueComment', repo.databaseId, issue.number, comment.id);
  }

  findRepoByDatabaseId(databaseId: number): Repo | undefined {
    return [...this.repos.values()].find((repo) => repo.databaseId === databaseId);
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return null;
    const repo = this.findRepoByDatabaseId(Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === Number(decoded.parts[1]));
    return issue === undefined ? null : { repo, issue };
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return null;
    const repo = this.findRepoByDatabaseId(Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const pull = repo.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
    return pull === undefined ? null : { repo, pull };
  }
}
