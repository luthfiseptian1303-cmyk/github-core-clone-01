// The git wire codecs: pkt-line framing and packfile reading/writing, pure
// TypeScript over the standard library. The suite's client writes plain packs
// (no deltas) and reads OFS/REF deltas including thin packs; this forge writes
// plain packs only — the checks accept zero deltas as long as every object
// resolves byte-identically.

import { createInflate, deflateSync } from 'node:zlib';
import { hashObject, sha1Hex, type GitObject, type ObjType } from './store.ts';

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > PKT_LINE_MAX) throw new Error('pktline-too-long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole pkt-line stream; throws on malformed framing. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pktline-truncated');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      lines.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      lines.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pktline-header');
    const length = parseInt(header, 16);
    if (length < 4) throw new Error('pktline-header');
    if (length > PKT_LINE_MAX) throw new Error('pktline-too-long');
    if (offset + length > buf.length) throw new Error('pktline-truncated');
    lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return lines;
}

/** The data payloads of a pkt-line stream, in order (control packets dropped). */
export function dataLines(buf: Buffer): Buffer[] {
  return decodePktLines(buf)
    .filter((line): line is { kind: 'data'; payload: Buffer } => line.kind === 'data')
    .map((line) => line.payload);
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let b = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Write a version-2 packfile with plain objects only, no deltas. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** Read a packfile (versions 2 or 3); throws on structural errors. Delta entries are refused. */
export async function readPack(buf: Buffer): Promise<Map<string, GitObject>> {
  if (buf.length < 32) throw new Error('pack-truncated');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const declaredCount = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer.toString('hex') !== expected) throw new Error('pack-checksum');

  const objects = new Map<string, GitObject>();
  let offset = 12;
  const end = buf.length - 20;
  let count = 0;
  while (offset < end) {
    if (count >= declaredCount) throw new Error('pack-trailing');
    // Varint header: type in bits 4-6 of the first byte, size low 4 bits, then
    // 7 bits per following byte with the 0x80 continuation bit.
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new Error('pack-truncated');
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) {
      throw new Error('pack-delta: delta objects are not accepted on receive');
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error('pack-type');
    // Inflate the entry's zlib stream. A deflate stream is self-terminating,
    // and the streaming inflater reports exactly how many input bytes it
    // consumed (bytesWritten), which is where the next entry starts.
    const { data, consumed } = await inflateOne(buf, offset, end);
    if (data.length !== size) throw new Error('pack-size');
    offset += consumed;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    count += 1;
  }
  if (count !== declaredCount) throw new Error('pack-count');
  if (offset !== end) throw new Error('pack-trailing');
  return objects;
}

/** Inflate one zlib stream starting at `offset`; resolves with its bytes and length. */
function inflateOne(buf: Buffer, offset: number, end: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    inflater.on('data', (chunk: Buffer) => chunks.push(chunk));
    inflater.on('error', (err: Error) => reject(new Error(`pack-zlib: ${err.message}`)));
    inflater.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inflater.bytesWritten }));
    inflater.end(buf.subarray(offset, end));
  });
}
