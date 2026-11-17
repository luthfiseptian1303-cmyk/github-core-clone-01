// Git smart HTTP: the /{owner}/{repo}.git surface — ref advertisements (protocol
// v2 for upload-pack when the client asks, v0 otherwise and always for
// receive-pack), v2 ls-refs, fetch over v2 and v0 (with shallow/deepen and the
// sideband-framed packfile section), and receive-pack with per-ref fast-forward
// rules and a report-status answer. No git binary anywhere: packfiles are built
// and parsed in TypeScript, and objects are stored in the forge's object map.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectAncestors,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type Repo,
} from './store.ts';
import { dataLines, encodePktLine, pktDelim, pktFlush, readPack, writePack } from './gitproto.ts';
import { queryOf, readBody, sendJson, type ForgeContext } from './http.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';

function sendGitBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, ctx: ForgeContext): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.nextRequestId(),
  });
  res.end(body);
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function advertisementV2(): Buffer {
  // Protocol v2 advertisements start directly with `version 2` — the
  // `# service=...` line is v0 smart-HTTP framing only. Real git servers
  // (verified against git http-backend) emit no service line here, and
  // git clients reject the advertisement if one is present.
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine('agent=github-core-clone/1.0\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function advertisementV0(repo: Repo, service: typeof UPLOAD_PACK | typeof RECEIVE_PACK): Buffer {
  const caps =
    service === UPLOAD_PACK
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1 agent=github-core-clone/1.0`
      : 'report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=github-core-clone/1.0';
  // Smart-HTTP v0 framing (verified against git http-backend): the service
  // line is followed by a FLUSH packet, then the ref lines, then a flush.
  // Real git clients reject the advertisement without that flush.
  const packets: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else if (service === UPLOAD_PACK) {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    packets.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const { name, oid } of refs) {
      packets.push(encodePktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
        packets.push(encodePktLine(`${parseTag(obj.data).object} ${name}^{}\n`));
      }
    }
  } else {
    // receive-pack advertises no HEAD line (verified against git
    // http-backend); the capabilities ride on the first ref line.
    refs.forEach(({ name, oid }, i) => {
      packets.push(encodePktLine(i === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
    });
  }
  packets.push(pktFlush());
  return Buffer.concat(packets);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: Buffer[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const arg = raw.toString('utf8').replace(/\n$/, '');
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (symrefs && matches('HEAD')) {
    if (mainTip !== undefined) {
      out.push(encodePktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    } else if (unborn) {
      out.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  for (const { name, oid } of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
    }
    out.push(encodePktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch (v2 and v0 share the pack computation)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

interface FetchResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  wantedRefs: { oid: string; ref: string }[];
  /** True when the client sent at least one `have` line. Real git servers
   * omit the acknowledgments section entirely when there are no haves, and
   * git clients expect the first section to be `packfile` (or shallow-info /
   * wanted-refs) in that case — sending `acknowledgments` + NAK makes the
   * client die with "expected 'packfile', received 'acknowledgments'". */
  hasHaves: boolean;
}

/** A commit plus its own tree closure (trees and blobs), but NOT its parents. */
function commitOwnObjects(objects: Map<string, GitObject>, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return out;
  const stack: string[] = [parseCommit(obj.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    out.add(oid);
    const entry = objects.get(oid);
    if (entry === undefined || entry.type !== 'tree') continue;
    for (const child of parseTree(entry.data)) {
      if (child.mode === '40000') stack.push(child.oid);
      else out.add(child.oid);
    }
  }
  return out;
}

function computeFetch(repo: Repo, args: FetchArgs): FetchResult {
  const included = collectReachable(repo.objects, args.wants, args.deepen ?? undefined);
  // Objects the client already holds. A `have` that is also one of the
  // client's shallow boundaries is held only as itself plus its tree —
  // the client does NOT have its parents, so they must stay out of this
  // set or a deepen would (wrongly) exclude the parent it asked for.
  const oldSet = new Set<string>();
  for (const have of args.haves) {
    if (args.shallow.includes(have)) {
      for (const oid of commitOwnObjects(repo.objects, have)) oldSet.add(oid);
    } else {
      for (const oid of collectReachable(repo.objects, [have]).all) oldSet.add(oid);
    }
  }
  const packObjects = [...included.all]
    .filter((oid) => !oldSet.has(oid) && repo.objects.has(oid))
    .map((oid) => repo.objects.get(oid) as { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer });
  const pack = writePack(packObjects);

  const unshallow: string[] = [];
  for (const boundary of args.shallow) {
    if (!included.commits.includes(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => included.commits.includes(parent))) unshallow.push(boundary);
  }

  const ancestors = collectAncestors(repo.objects, args.wants);
  const acks = args.haves.filter((have) => ancestors.has(have));

  const wantedRefs: { oid: string; ref: string }[] = [];
  for (const want of args.wants) {
    for (const { name, oid } of sortedRefs(repo)) {
      if (oid === want) wantedRefs.push({ oid: want, ref: name });
    }
  }
  return { pack, shallow: included.boundary, unshallow, acks, wantedRefs, hasHaves: args.haves.length > 0 };
}

/** Split a pack into sideband band-1 packets (each well under the pkt-line cap). */
function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) {
    // An empty pack is still a pack: one band-1 packet carrying its 32 bytes
    // is impossible when the pack is empty, so send the (non-empty) empty pack.
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return chunks;
}

function fetchResponseV2(result: FetchResult): Buffer {
  const out: Buffer[] = [];
  if (result.hasHaves) {
    out.push(encodePktLine('acknowledgments\n'));
    if (result.acks.length > 0) {
      for (const ack of result.acks) out.push(encodePktLine(`ACK ${ack}\n`));
    } else {
      out.push(encodePktLine('NAK\n'));
    }
    // The `ready` line tells the client the server has settled the common
    // commits and the packfile follows (verified against git daemon: ACKs
    // then `ready`, then the delimiter). Without it the client dies with
    // "expected no other sections to be sent after no 'ready'".
    out.push(encodePktLine('ready\n'));
    out.push(pktDelim());
  }
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    out.push(encodePktLine('shallow-info\n'));
    for (const oid of result.shallow) out.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(encodePktLine(`unshallow ${oid}\n`));
    out.push(pktDelim());
  }
  if (result.wantedRefs.length > 0) {
    out.push(encodePktLine('wanted-refs\n'));
    for (const { oid, ref } of result.wantedRefs) out.push(encodePktLine(`${oid} ${ref}\n`));
    out.push(pktDelim());
  }
  out.push(encodePktLine('packfile\n'));
  out.push(...sidebandChunks(result.pack));
  out.push(pktFlush());
  return Buffer.concat(out);
}

function fetchResponseV0(result: FetchResult): Buffer {
  const out: Buffer[] = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) out.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    out.push(encodePktLine('NAK\n'));
  }
  for (const oid of result.shallow) out.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) out.push(encodePktLine(`unshallow ${oid}\n`));
  out.push(...sidebandChunks(result.pack));
  out.push(pktFlush());
  return Buffer.concat(out);
}

function parseFetchV2(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.deepen = n;
    }
  }
  return args;
}

function parseFetchV0(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want carries the negotiated features after the oid.
      const rest = line.slice(5).trim().split(/\s+/);
      if (rest[0] !== undefined && isOid(rest[0])) args.wants.push(rest[0]);
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.deepen = n;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command list, the client's capabilities, and the raw pack. */
function splitPushBody(body: Buffer): { commands: PushCommand[]; clientCaps: string[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let clientCaps: string[] = [];
  let offset = 0;
  let pack = Buffer.alloc(0);
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pktline-truncated');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      pack = body.subarray(offset + 4);
      break;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pktline-header');
    const length = parseInt(header, 16);
    if (length < 4 || offset + length > body.length) throw new Error('pktline-truncated');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    let commandText = line;
    if (nul !== -1) {
      commandText = line.slice(0, nul);
      clientCaps = line.slice(nul + 1).split(' ').filter(Boolean);
    }
    const parts = commandText.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error('push-command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, clientCaps, pack };
}

async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { commands, clientCaps, pack } = splitPushBody(body);
  const sideband = clientCaps.includes('side-band-64k');

  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const objects = await readPack(pack);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}`];
  for (const cmd of commands) {
    let ok = true;
    let reason = '';
    if (unpackError !== null) {
      ok = false;
      reason = 'unpack failed';
    } else {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      if (cmd.newOid === ZERO_OID) {
        // Delete: the old tip must match.
        if (current === ZERO_OID || cmd.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create: the ref must not exist, and the new objects must be here.
        if (current !== ZERO_OID || !repo.objects.has(cmd.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        // Update: the old tip must match and the new tip must descend from it.
        if (cmd.oldOid !== current || !isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
    } else {
      reportLines.push(`ng ${cmd.ref} ${reason}`);
    }
  }

  const out: Buffer[] = [];
  if (sideband) {
    // Progress goes on band 2 as raw text (first, as real git does).
    out.push(encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from('Counting objects: 100%, done.\n', 'utf8')])));
    // The report-status lines are themselves pkt-line framed INSIDE band-1
    // packets (verified against git http-backend): the client's sideband
    // demultiplexer feeds the band-1 payload to a packet reader, which
    // expects inner pkt-lines — raw text there dies with
    // "bad line length character: unpa". Chunk the inner stream so no
    // band-1 packet exceeds the pkt-line cap.
    const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(`${line}\n`)), pktFlush()]);
    for (let offset = 0; offset < inner.length; offset += 60000) {
      const slice = inner.subarray(offset, Math.min(offset + 60000, inner.length));
      out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    for (const line of reportLines) out.push(encodePktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Handle a git smart-HTTP request. Returns true when the path was a git path. */
export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<boolean> {
  const urlPath = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(urlPath);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const rest = match[3] ?? '';
  const method = req.method ?? 'GET';

  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' }, ctx);
    return true;
  }

  try {
    if (method === 'GET' && rest === 'info/refs') {
      const service = queryOf(req).get('service');
      if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
        sendJson(res, 404, { message: 'Not Found' }, ctx);
        return true;
      }
      const wantsV2 = service === UPLOAD_PACK && req.headers['git-protocol'] === 'version=2';
      const body = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
      sendGitBytes(res, 200, body, `application/x-${service}-advertisement`, ctx);
      return true;
    }

    if (method === 'POST' && rest === UPLOAD_PACK) {
      const body = await readBody(req);
      const lines = dataLines(body);
      if (lines.length === 0) throw new Error('empty request');
      const first = lines[0].toString('utf8').replace(/\n$/, '');
      let answer: Buffer;
      if (first.startsWith('command=ls-refs')) {
        answer = handleLsRefs(repo, lines);
      } else if (first.startsWith('command=fetch')) {
        answer = fetchResponseV2(computeFetch(repo, parseFetchV2(lines)));
      } else if (first.startsWith('want ')) {
        // A v0 fetch: no Git-Protocol header, no command= line — the body is
        // the want/have list itself. The client only fetches v0 when the
        // advertisement was v0, so this path is a fallback for completeness.
        answer = fetchResponseV0(computeFetch(repo, parseFetchV0(lines)));
      } else {
        throw new Error('unknown command');
      }
      sendGitBytes(res, 200, answer, `application/x-${UPLOAD_PACK}-result`, ctx);
      return true;
    }

    if (method === 'POST' && rest === RECEIVE_PACK) {
      const body = await readBody(req);
      const answer = await handleReceivePack(repo, body);
      sendGitBytes(res, 200, answer, `application/x-${RECEIVE_PACK}-result`, ctx);
      return true;
    }

    sendJson(res, 404, { message: 'Not Found' }, ctx);
    return true;
  } catch (err) {
    // A malformed git request (the suite sends one on purpose) must never take
    // the server down: answer 400 and keep serving.
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' }, ctx);
    return true;
  }
}
