// Git primitives: object hashing, pkt-line framing, packfile read/write
// (with OFS/REF delta support), tree manipulation, commit creation, merge-base
// and file-level three-way merge. Pure functions over a repo's object store.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line too large');
  const len = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktChunk {
  kind: 'flush' | 'delim' | 'end' | 'data';
  data: Buffer;
}

/** Parse a whole pkt-line buffer into chunks. Returns null on malformed input. */
export function parsePktLines(buffer: Buffer): PktChunk[] | null {
  const chunks: PktChunk[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) return null;
    const lenHex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') { chunks.push({ kind: 'flush', data: Buffer.alloc(0) }); offset += 4; continue; }
    if (lenHex === '0001') { chunks.push({ kind: 'delim', data: Buffer.alloc(0) }); offset += 4; continue; }
    if (lenHex === '0002') { chunks.push({ kind: 'end', data: Buffer.alloc(0) }); offset += 4; continue; }
    const len = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buffer.length) return null;
    chunks.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return chunks;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], message, author: '', committer: '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(tree: string, parents: string[], message: string, author: string, committer: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export function getCommit(objects: Map<string, GitObject>, oid: string): CommitInfo | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {mode, oid}. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(objects, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

/** Build a tree from a flat path map, storing intermediate trees. Returns root oid. */
export function buildTreeFromFlat(objects: Map<string, GitObject>, flat: Map<string, { mode: string; oid: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    for (const [path, v] of flat) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (!sub) { sub = new Map(); subdirs.set(dir, sub); }
        sub.set(path, v);
      } else {
        entries.push({ mode: v.mode, name: rest, oid: v.oid });
      }
    }
    for (const [dir, sub] of subdirs) {
      entries.push({ mode: '40000', name: dir, oid: build(prefix ? `${prefix}/${dir}` : dir) });
    }
    return storeObject(objects, 'tree', buildTree(entries));
  };
  return build('');
}

/** Set (or delete with null) a path in a tree. Returns the new root tree oid. */
export function setTreePath(objects: Map<string, GitObject>, rootTreeOid: string | null, path: string, mode: string | null, blobOid: string | null): string {
  const flat = rootTreeOid ? flattenTree(objects, rootTreeOid) : new Map<string, { mode: string; oid: string }>();
  if (blobOid === null || mode === null) flat.delete(path);
  else flat.set(path, { mode, oid: blobOid });
  return buildTreeFromFlat(objects, flat);
}

/** Look up the blob oid at a path in a tree, or null. */
export function getTreePath(objects: Map<string, GitObject>, rootTreeOid: string | null, path: string): { mode: string; oid: string } | null {
  if (!rootTreeOid) return null;
  const flat = flattenTree(objects, rootTreeOid);
  return flat.get(path) ?? null;
}

/** Create a commit on top of `parentOid` (or null for a root commit) that sets one file. */
export function commitFile(
  objects: Map<string, GitObject>,
  parentOid: string | null,
  path: string,
  content: Buffer,
  message: string,
  authorLine: string,
): string {
  const parent = parentOid ? getCommit(objects, parentOid) : null;
  const baseTree = parent ? parent.tree : null;
  const blobOid = storeObject(objects, 'blob', content);
  const newTree = setTreePath(objects, baseTree, path, '100644', blobOid);
  const parents = parentOid ? [parentOid] : [];
  return storeObject(objects, 'commit', buildCommit(newTree, parents, message, authorLine, authorLine));
}

// ---------------------------------------------------------------- reachability

/** All object oids reachable from the given commits (commit, trees, blobs, tags). */
export function reachable(objects: Map<string, GitObject>, startOids: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...startOids];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) stack.push(m[1] as string);
    }
  }
  return seen;
}

export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(objects, oid);
    if (c) stack.push(...c.parents);
  }
  return false;
}

/** Merge-base: the most recent common ancestor of two commits (first by BFS order). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const qa: string[] = [a];
  while (qa.length > 0) {
    const oid = qa.shift() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const c = getCommit(objects, oid);
    if (c) qa.push(...c.parents);
  }
  const seen = new Set<string>();
  const qb: string[] = [b];
  while (qb.length > 0) {
    const oid = qb.shift() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(objects, oid);
    if (c) qb.push(...c.parents);
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

function readVarint(data: Buffer, offset: number): { value: number; bytes: number } {
  let value = data[offset] as number & 0x7f;
  let bytes = 1;
  let shift = 7;
  while ((data[offset] as number & 0x80) !== 0) {
    value |= ((data[offset + bytes] as number & 0x7f) << shift);
    shift += 7;
    bytes += 1;
  }
  return { value, bytes };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const { value: sourceSize, bytes: b1 } = readVarint(delta, offset);
  offset += b1;
  const { value: targetSize, bytes: b2 } = readVarint(delta, offset);
  offset += b2;
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      if (op & 0x01) copyOff = delta[offset] as number, offset += 1;
      if (op & 0x02) copyOff |= (delta[offset] as number) << 8, offset += 1;
      if (op & 0x04) copyOff |= (delta[offset] as number) << 16, offset += 1;
      if (op & 0x08) copyOff |= (delta[offset] as number) << 24, offset += 1;
      if (op & 0x10) copySize = delta[offset] as number, offset += 1;
      if (op & 0x20) copySize |= (delta[offset] as number) << 8, offset += 1;
      if (op & 0x40) copySize |= (delta[offset] as number) << 16, offset += 1;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOff, copyOff + copySize));
      written += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || written !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

// zlib inflate via node:zlib (sync, whole-buffer)
import { inflateSync, deflateSync } from 'node:zlib';

// Inflate the zlib stream starting at `start` and find its exact end.
// inflateSync ignores trailing bytes, so the predicate "inflate succeeds" is
// monotone in the end offset: false below the true stream end, true at/above
// it. Binary search finds the smallest successful end, i.e. the stream end.
// Verified empirically against node 24's zlib.
function inflateAt(data: Buffer, start: number, maxEnd: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  const succeeds = (end: number): boolean => {
    try {
      inflateSync(data.subarray(start, end));
      return true;
    } catch {
      return false;
    }
  };
  let lo = start;
  let hi = maxEnd;
  if (!succeeds(hi)) throw new Error('could not inflate pack entry');
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (succeeds(mid)) hi = mid;
    else lo = mid;
  }
  const out = inflateSync(data.subarray(start, hi));
  if (out.length !== expectedSize) throw new Error('pack entry size mismatch');
  return { data: out, nextOffset: hi };
}

/** Parse a packfile into resolved objects (deltas applied). */
export function readPackEntries(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: { offset: number; type: number; size: number; data: Buffer; baseOid?: string; baseOffset?: number }[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset] as number;
    let type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (((pack[offset - 1] as number) & 0x80) !== 0) {
      const b = pack[offset] as number;
      size |= (b & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      const b0 = pack[offset] as number;
      let baseOff = b0 & 0x7f;
      offset += 1;
      while ((b0 & 0x80) !== 0) {
        const b = pack[offset] as number;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
        offset += 1;
      }
      baseOffset = entryOffset - baseOff;
    } else if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset, trailerStart, size);
    offset = inflated.nextOffset;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ offset: entryOffset, type, size, data: inflated.data, baseOid, baseOffset });
  }
  const TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolved = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const resolve = (entry: (typeof raw)[number]): GitObject => {
    const byOff = byOffset.get(entry.offset);
    if (byOff) return byOff;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.type === 6 && entry.baseOffset !== undefined) {
        const baseEntry = raw.find((e) => e.offset === entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base not found');
        base = resolve(baseEntry);
      } else if (entry.baseOid) {
        base = resolved.get(entry.baseOid);
        if (!base) throw new Error('ref-delta base not found in pack');
      }
      if (!base) throw new Error('delta base missing');
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      resolved.set(oid, obj);
      byOffset.set(entry.offset, obj);
      return obj;
    }
    const type = TYPE_NAMES[entry.type];
    if (!type) throw new Error(`unknown pack object type ${entry.type}`);
    const obj: GitObject = { type, data: entry.data };
    const oid = hashObject(type, entry.data);
    resolved.set(oid, obj);
    byOffset.set(entry.offset, obj);
    return obj;
  };
  for (const entry of raw) resolve(entry);
  return resolved;
}

function writeVarintSize(type: number, size: number): Buffer {
  const first = ((type & 0x07) << 4) | (size & 0x0f);
  let rest = size >> 4;
  const bytes = [first];
  while (rest > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(rest & 0x7f);
    rest >>= 7;
  }
  return Buffer.from(bytes);
}

/** Serialize objects (non-delta) as a packfile v2 with a correct trailer. */
export function writePack(objects: { oid: string; type: GitObjectType; data: Buffer }[]): Buffer {
  const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  parts.push(header);
  for (const o of objects) {
    parts.push(writeVarintSize(TYPE_NUM[o.type], o.data.length));
    parts.push(deflateSync(o.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Split a buffer into sideband pkt-lines (band 1), each chunk <= 65520 bytes. */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
    offset += chunk.length;
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch/push

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow?: number;
  deepen?: { type: 'depth' | 'since' | 'not'; value: number | string };
  filter?: string;
  /** The client's current shallow boundaries (from `shallow <oid>` lines). */
  shallowBoundaries?: string[];
}

export interface FetchResult {
  objects: { oid: string; type: GitObjectType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the pack for a fetch: walk from wants with a generation counter,
 * honouring haves and depth limits. Mirrors the kit's fetch semantics.
 *
 * - A commit is sent when it is not a have and its generation is below the
 *   depth limit (or there is no limit). A sent commit whose parents fall at
 *   or beyond the limit is a shallow boundary (its parents are cut off).
 * - A have is never sent. Past a have we traverse only when a depth limit
 *   allows it (its parents may still be within depth).
 * - Only the objects of the sent commits are included: a sent commit's tree
 *   (recursively) and blobs. History beyond the depth limit is never sent.
 * - Objects the client already holds are excluded: for each have, the have
 *   itself plus its tree, and — unless the have is one of the client's
 *   shallow boundaries — everything reachable from its ancestors.
 * - A client's shallow boundary whose parent is now sent becomes unshallow.
 */
export function computeFetch(objects: Map<string, GitObject>, req: FetchRequest): FetchResult {
  const depth = req.deepen?.type === 'depth' ? req.deepen.value as number : undefined;
  const haveSet = new Set(req.haves);
  const clientShallow = new Set(req.shallowBoundaries ?? []);
  const sent = new Set<string>();
  const shallow: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  const queued = new Set<string>();
  for (const w of req.wants) {
    if (!queued.has(w)) { queued.add(w); queue.push({ oid: w, gen: 0 }); }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!haveSet.has(oid)) sent.add(oid);
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m && !queued.has(m[1] as string)) {
        queued.add(m[1] as string);
        queue.push({ oid: m[1] as string, gen });
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (haveSet.has(oid)) {
      // A have is never sent. Traverse past it only when a depth limit allows
      // its parents to still be within depth.
      if (depth !== undefined && gen < depth) {
        for (const p of commit.parents) {
          if (!queued.has(p)) { queued.add(p); queue.push({ oid: p, gen: gen + 1 }); }
        }
      }
      continue;
    }
    if (depth !== undefined && gen >= depth) continue;
    sent.add(oid);
    if (depth !== undefined && gen + 1 >= depth) {
      // Parents fall at or beyond the limit: this commit is the boundary.
      shallow.push(oid);
    } else {
      for (const p of commit.parents) {
        if (!queued.has(p)) { queued.add(p); queue.push({ oid: p, gen: gen + 1 }); }
      }
    }
  }
  // Unshallow: a client's shallow boundary whose parent is now sent.
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const boundary of clientShallow) {
      if (!haveSet.has(boundary)) continue;
      const c = getCommit(objects, boundary);
      if (c && c.parents.some((p) => sent.has(p))) unshallow.push(boundary);
    }
  }
  // Collect the objects of the sent commits: the commit itself plus its tree.
  const sendOids = new Set<string>();
  const collectTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (sendOids.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      sendOids.add(oid);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  for (const oid of sent) {
    sendOids.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') collectTree(parseCommit(obj.data).tree);
  }
  // What the client already holds: each have plus its tree, and — unless the
  // have is a client shallow boundary — everything reachable from its ancestors.
  const held = new Set<string>();
  const heldStack = [...haveSet];
  const collectTreeHeld = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    if (held.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      collectTreeHeld(parseCommit(obj.data).tree);
      if (!clientShallow.has(oid)) heldStack.push(...parseCommit(obj.data).parents);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) heldStack.push(m[1] as string);
    }
  }
  const toSend: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  for (const oid of sendOids) {
    if (held.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj) toSend.push({ oid, type: obj.type, data: obj.data });
  }
  return { objects: toSend, shallow, unshallow };
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: ref-update pkt-lines up to the first flush, then the packfile.
 * The pack is raw binary, not pkt-lined, so the pkt-line walk must stop at the flush. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('malformed push body');
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      offset += 4;
      break;
    }
    const len = Number.parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) throw new Error('malformed push body');
    const text = body.subarray(offset + 4, offset + len).toString('utf8');
    const parts = text.trim().split(' ');
    if (parts.length >= 3) {
      const [oldOid, newOid, refRaw] = parts as [string, string, string];
      // The first command line carries capabilities after a NUL.
      const ref = refRaw.split('\0')[0] as string;
      commands.push({ oldOid, newOid, ref });
    }
    offset += len;
  }
  const pack = body.subarray(offset);
  return { commands, pack: pack.length > 0 ? pack : null };
}

// ---------------------------------------------------------------- diff/merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function countLineDiff(a: Buffer | null, b: Buffer | null): { additions: number; deletions: number } {
  const aLines = a ? a.toString('utf8').split('\n') : [];
  const bLines = b ? b.toString('utf8').split('\n') : [];
  if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();
  // LCS on lines (files here are small; the kit's fixtures are a few KB at most).
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = aLines[i] === bLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const lcs = dp[0]![0] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const base = baseTreeOid ? flattenTree(objects, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const head = headTreeOid ? flattenTree(objects, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const content = objects.get(b.oid)?.data ?? null;
      const { additions, deletions } = countLineDiff(content, null);
      changes.push({ filename: path, status: 'removed', additions, deletions, changes: additions + deletions });
    } else if (!b && h) {
      const content = objects.get(h.oid)?.data ?? null;
      const { additions, deletions } = countLineDiff(null, content);
      changes.push({ filename: path, status: 'added', additions, deletions, changes: additions + deletions });
    } else if (b && h && b.oid !== h.oid) {
      const aContent = objects.get(b.oid)?.data ?? null;
      const bContent = objects.get(h.oid)?.data ?? null;
      const { additions, deletions } = countLineDiff(aContent, bContent);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  changes.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  return changes;
}

export interface MergeResult {
  tree: string;
  conflict: boolean;
  conflictedPaths: string[];
}

/** File-level three-way merge. Returns the merged tree oid and whether it conflicts. */
export function threeWayMerge(
  objects: Map<string, GitObject>,
  baseTip: string | null,
  headTip: string,
  otherTip: string,
): MergeResult {
  const baseTree = baseTip ? getCommit(objects, baseTip)?.tree ?? null : null;
  const headTree = getCommit(objects, headTip)?.tree ?? null;
  const otherTree = getCommit(objects, otherTip)?.tree ?? null;
  const base = baseTree ? flattenTree(objects, baseTree) : new Map<string, { mode: string; oid: string }>();
  const head = headTree ? flattenTree(objects, headTree) : new Map<string, { mode: string; oid: string }>();
  const other = otherTree ? flattenTree(objects, otherTree) : new Map<string, { mode: string; oid: string }>();
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicted: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys(), ...other.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const o = other.get(path);
    const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
    const otherChanged = (b?.oid ?? null) !== (o?.oid ?? null);
    if (headChanged && otherChanged) {
      // both changed: conflict unless they changed to the same thing
      if ((h?.oid ?? null) === (o?.oid ?? null)) {
        if (h) merged.set(path, h);
      } else {
        conflicted.push(path);
        if (h) merged.set(path, h);
      }
    } else if (headChanged) {
      if (h) merged.set(path, h);
    } else if (otherChanged) {
      if (o) merged.set(path, o);
    } else if (b) {
      merged.set(path, b);
    }
  }
  const tree = buildTreeFromFlat(objects, merged);
  return { tree, conflict: conflicted.length > 0, conflictedPaths: conflicted };
}
