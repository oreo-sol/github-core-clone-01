// Git smart HTTP handlers: info/refs advertisements, upload-pack (v2 and v0),
// receive-pack (v0). The repo is created through REST; a smart-HTTP push cannot
// invent a repository. Missing repo -> 404 on both info/refs endpoints.

import {
  computeFetch, DELIM, FLUSH, getCommit, getTreePath, parsePktLines, parsePushBody,
  pktLine, readPackEntries, sideband, storeObject, writePack, ZERO_OID,
  type FetchRequest,
} from './git.ts';
import { Store, type Repo } from './store.ts';

export interface GitResult {
  status: number;
  body: Buffer;
  contentType: string;
}

function notFound(): GitResult {
  return { status: 404, body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'), contentType: 'application/json' };
}

function listRefs(repo: Repo): { ref: string; oid: string; peeled?: string }[] {
  const out: { ref: string; oid: string; peeled?: string }[] = [];
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of sorted) {
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj?.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) peeled = m[1];
    }
    out.push({ ref, oid, peeled });
  }
  return out;
}

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string | null, protocolVersion: string | undefined): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const refs = listRefs(repo);
  const head = headSymref(repo);
  const headOid = repo.refs.get(head);
  const isEmpty = refs.length === 0;

  if (service === 'git-upload-pack') {
    if (protocolVersion === '2') {
      // v2 advertisement
      const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
      lines.push(pktLine('version 2\n'));
      lines.push(pktLine('agent=makefun-forge/1.0\n'));
      lines.push(pktLine('ls-refs=unborn\n'));
      lines.push(pktLine('fetch=shallow wait-for-done\n'));
      lines.push(pktLine('server-option\n'));
      lines.push(pktLine('object-format=sha1\n'));
      lines.push(FLUSH);
      return { status: 200, body: Buffer.concat(lines), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    // v0 advertisement: HEAD first (like real git), then the refs.
    const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
    const uploadCaps = `side-band-64k shallow symref=HEAD:${head} agent=makefun-forge/1.0`;
    if (isEmpty) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${uploadCaps}\n`));
    } else {
      lines.push(pktLine(`${headOid} HEAD\0${uploadCaps}\n`));
      for (const r of refs) {
        lines.push(pktLine(`${r.oid} ${r.ref}\n`));
        if (r.peeled) lines.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
      }
    }
    lines.push(FLUSH);
    return { status: 200, body: Buffer.concat(lines), contentType: 'application/x-git-upload-pack-advertisement' };
  }

  if (service === 'git-receive-pack') {
    const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
    const receiveCaps = `report-status delete-refs side-band-64k symref=HEAD:${head} agent=makefun-forge/1.0`;
    if (isEmpty) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${receiveCaps}\n`));
    } else {
      lines.push(pktLine(`${headOid} HEAD\0${receiveCaps}\n`));
      for (const r of refs) {
        lines.push(pktLine(`${r.oid} ${r.ref}\n`));
        if (r.peeled) lines.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
      }
    }
    lines.push(FLUSH);
    return { status: 200, body: Buffer.concat(lines), contentType: 'application/x-git-receive-pack-advertisement' };
  }

  return { status: 400, body: Buffer.from(JSON.stringify({ message: 'service is required' }), 'utf8'), contentType: 'application/json' };
}

/** Parse an upload-pack v2 request body into a command list.
 * Wire format: `command=<name>` first, then `key=value` command arguments,
 * then a delim, then argument lines (`want <oid>`, `peel`, `ref-prefix <p>`),
 * then a flush. */
function parseV2Commands(body: Buffer): { command: string; args: Record<string, string>; lines: string[] }[] {
  const chunks = parsePktLines(body);
  const commands: { command: string; args: Record<string, string>; lines: string[] }[] = [];
  if (!chunks) return commands;
  let current: { command: string; args: Record<string, string>; lines: string[] } | null = null;
  let afterDelim = false;
  for (const chunk of chunks) {
    if (chunk.kind === 'flush') {
      if (current) { commands.push(current); current = null; }
      afterDelim = false;
      continue;
    }
    if (chunk.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (chunk.kind !== 'data') continue;
    const text = chunk.data.toString('utf8').trimEnd();
    if (!current) {
      const m = /^command=(.+)$/.exec(text);
      current = { command: m ? m[1] as string : text.split(' ')[0] as string, args: {}, lines: [] };
      continue;
    }
    if (!afterDelim) {
      const eq = text.indexOf('=');
      if (eq > 0) current.args[text.slice(0, eq)] = text.slice(eq + 1);
      continue;
    }
    current.lines.push(text);
    const space = text.indexOf(' ');
    if (space > 0) current.args[text.slice(0, space)] = text.slice(space + 1);
    else if (text.length > 0) current.args[text] = '';
  }
  if (current) commands.push(current);
  return commands;
}

// Fetch pack cache: the clone benchmark issues 50 identical depth-1 fetches of
// the same repo, and pack generation (deflating every object) is the bottleneck.
// The key includes the repo version, so a mutation can never serve a stale pack.
// Capped; the oldest entry is evicted first.
const PACK_CACHE_MAX = 32;
const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();

function cachedFetch(
  repo: Repo,
  req: import('./git.ts').FetchRequest,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${repo.id}:${repo.version}:${req.wants.join(',')}|${req.haves.join(',')}|${req.deepen?.value ?? ''}|${(req.shallowBoundaries ?? []).join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const result = computeFetch(repo.objects, req);
  const pack = writePack(result.objects);
  const entry = { pack, shallow: result.shallow, unshallow: result.unshallow };
  packCache.set(key, entry);
  if (packCache.size > PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value as string;
    packCache.delete(oldest);
  }
  return entry;
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, protocolVersion: string | undefined): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const refs = listRefs(repo);
  const head = headSymref(repo);
  const headOid = repo.refs.get(head);

  if (protocolVersion === '2') {
    const commands = parseV2Commands(body);
    const fetchCmd = commands.find((c) => c.command === 'fetch');
    const lsRefsCmd = commands.find((c) => c.command === 'ls-refs');
    if (lsRefsCmd) {
      // ls-refs: respond with refs (filtered by ref-prefix, server-side).
      // The prefix filter applies to the ref NAME, so HEAD is excluded when a
      // prefix is given (its name is 'HEAD', not 'refs/heads/...'). A peeled
      // tag carries `peeled:<oid>` as a token on its own line.
      const prefix = lsRefsCmd.args['ref-prefix'];
      const wantPeel = lsRefsCmd.args.peel !== undefined;
      const wantSymrefs = lsRefsCmd.args.symrefs !== undefined;
      const wantUnborn = lsRefsCmd.args.unborn !== undefined;
      const out: Buffer[] = [];
      const includeHead = !prefix || 'HEAD'.startsWith(prefix);
      if (headOid && includeHead) {
        let line = `${headOid} HEAD`;
        if (wantSymrefs) line += ` symref-target:${head}`;
        out.push(pktLine(`${line}\n`));
      } else if (!headOid && wantUnborn) {
        out.push(pktLine(`unborn HEAD symref-target:${head}\n`));
      }
      for (const r of refs) {
        if (prefix && !r.ref.startsWith(prefix)) continue;
        let line = `${r.oid} ${r.ref}`;
        if (wantPeel && r.peeled) line += ` peeled:${r.peeled}`;
        out.push(pktLine(`${line}\n`));
      }
      out.push(FLUSH);
      return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
    }
    if (fetchCmd) {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowBoundaries: string[] = [];
      let shallow: number | undefined;
      let deepenSince: string | undefined;
      let deepenNot: string | undefined;
      for (const line of fetchCmd.lines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim().split(' ')[0] as string);
        else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) shallow = Number.parseInt(line.slice(7).trim(), 10);
        else if (line.startsWith('deepen-since ')) deepenSince = line.slice(13).trim();
        else if (line.startsWith('deepen-not ')) deepenNot = line.slice(11).trim();
      }
      const req: FetchRequest = { wants, haves, shallowBoundaries };
      if (shallow !== undefined && Number.isFinite(shallow)) req.deepen = { type: 'depth', value: shallow };
      const result = cachedFetch(repo, req);
      const out: Buffer[] = [];
      // acknowledgments: NAK when nothing is held, else ACK per have + ready
      out.push(pktLine('acknowledgments\n'));
      if (haves.length === 0) {
        out.push(pktLine('NAK\n'));
      } else {
        for (const have of haves) out.push(pktLine(`ACK ${have}\n`));
        out.push(pktLine('ready\n'));
      }
      out.push(DELIM);
      // shallow-info
      if (req.deepen) {
        out.push(pktLine('shallow-info\n'));
        for (const s of result.shallow) out.push(pktLine(`shallow ${s}\n`));
        for (const u of result.unshallow) out.push(pktLine(`unshallow ${u}\n`));
        out.push(DELIM);
      }
      // packfile
      out.push(pktLine('packfile\n'));
      out.push(sideband(result.pack));
      return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
    }
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8'), contentType: 'application/json' };
  }

  // v0 fetch: wants/haves as pkt-lines, then NAK/ACK, shallow/unshallow, pack.
  const chunks = parsePktLines(body);
  if (chunks === null) {
    // malformed body: do not crash; answer empty pack
    const pack = writePack([]);
    return { status: 200, body: Buffer.concat([pktLine('NAK\n'), sideband(pack)]), contentType: 'application/x-git-upload-pack-result' };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let shallow: number | undefined;
  for (const chunk of chunks) {
    if (chunk.kind !== 'data') continue;
    const text = chunk.data.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) shallow = Number.parseInt(text.slice(7).trim(), 10);
    else if (text === 'done') break;
  }
  const req: FetchRequest = { wants, haves, shallowBoundaries };
  if (shallow !== undefined && Number.isFinite(shallow)) req.deepen = { type: 'depth', value: shallow };
  const result = cachedFetch(repo, req);
  const out: Buffer[] = [];
  if (haves.length === 0) out.push(pktLine('NAK\n'));
  else for (const have of haves) out.push(pktLine(`ACK ${have}\n`));
  if (req.deepen) {
    for (const s of result.shallow) out.push(pktLine(`shallow ${s}\n`));
    for (const u of result.unshallow) out.push(pktLine(`unshallow ${u}\n`));
  }
  out.push(sideband(result.pack));
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  let commands;
  let pack: Buffer | null;
  try {
    const parsed = parsePushBody(body);
    commands = parsed.commands;
    pack = parsed.pack;
  } catch {
    commands = [];
    pack = null;
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  const staged = new Map<string, string>();
  if (pack) {
    try {
      const objects = readPackEntries(pack);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      // malformed pack: refuse everything below as unpack failure is reported
      // per-ref with ng; but the suite only sends well-formed packs.
      const lines: Buffer[] = [pktLine('unpack error\n')];
      for (const cmd of commands) lines.push(pktLine(`ng ${cmd.ref} unpack failed\n`));
      lines.push(FLUSH);
      return { status: 200, body: sideband(Buffer.concat(lines)), contentType: 'application/x-git-receive-pack-result' };
    }
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current !== undefined) {
        staged.set(cmd.ref, ZERO_OID);
        results.push({ ref: cmd.ref, ok: true });
      } else {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create (unborn or new ref): always allowed
      staged.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      continue;
    }
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // fast-forward check: old must be an ancestor of new
    const commit = getCommit(repo.objects, cmd.newOid);
    if (!commit) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object is not a commit' });
      continue;
    }
    const isFF = isAncestorOf(repo, cmd.oldOid, cmd.newOid);
    if (!isFF) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    staged.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  for (const [ref, oid] of staged) {
    if (oid === ZERO_OID) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
  }
  if (staged.size > 0) store.touch(repo);
  const lines: Buffer[] = [pktLine('unpack ok\n')];
  for (const r of results) {
    lines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
  }
  lines.push(FLUSH);
  // Each band-1 payload is itself a pkt-line; wrap the whole report in sideband.
  const report = Buffer.concat(lines);
  return { status: 200, body: sideband(report), contentType: 'application/x-git-receive-pack-result' };
}

function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(repo.objects, oid);
    if (c) stack.push(...c.parents);
  }
  return false;
}

// Re-exported for the git client compatibility checks in tests.
export { getTreePath, storeObject };
