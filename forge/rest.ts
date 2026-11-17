// REST v3 handlers. Every handler returns { status, body, headers? } where body
// is the JSON value to serialize. The app layer adds X-GitHub-Request-Id and
// the JSON content type. Errors are { message: string }.

import {
  buildCommit, commitFile, diffTrees, flattenTree, getCommit, getTreePath,
  hashObject, mergeBase, parseCommit, parseTree, setTreePath, storeObject, threeWayMerge,
  ZERO_OID, type GitObject,
} from './git.ts';
import { Store, type Comment, type Issue, type Label, type Pull, type Repo } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const b64encode = (data: Buffer): string => data.toString('base64');
const b64decode = (text: string): Buffer => Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');

function repoView(store: Store, repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User', avatar_url: '' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `${origin}/${repo.fullName}`,
    url: `${origin}/api/v3/repos/${repo.fullName}`,
    clone_url: `${origin}/${repo.fullName}.git`,
    git_url: `${origin}/${repo.fullName}.git`,
    ssh_url: `git@github.invalid:${repo.fullName}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: label.name.length * 7919 + 1, node_id: `LA_${label.name}`, name: label.name, color: label.color, description: label.description ?? '', default: true, url: '' };
}

function userView(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: `U_${id}`, avatar_url: '', type: 'User', site_admin: false };
}

function issueView(store: Store, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userView(issue.user.login, issue.user.id),
    labels: issue.labels.map(labelView),
    assignees: issue.assignees.map((a) => userView(a.login, a.id)),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${origin}/${repo.fullName}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.fullName}`,
    author_association: 'OWNER',
  };
}

function pullView(store: Store, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userView(pull.user.login, pull.user.id),
    labels: [],
    assignees: [],
    head: { label: pull.head.label, ref: pull.head.ref, sha: pull.head.sha, repo: repoView(store, repo, origin) },
    base: { label: pull.base.label, ref: pull.base.ref, sha: pull.base.sha, repo: repoView(store, repo, origin) },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `${origin}/${repo.fullName}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    diff_url: `${origin}/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${repo.fullName}/pull/${pull.number}.patch`,
    author_association: 'OWNER',
  };
}

function commentView(store: Store, repo: Repo, number: number, comment: Comment, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userView(comment.user.login, comment.user.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${origin}/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${repo.fullName}/issues/${number}`,
    author_association: 'OWNER',
  };
}

function commitView(repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const commit = getCommit(repo.objects, sha);
  if (!commit) return null;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: commit.message,
      author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: '' },
      committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: '' },
      tree: { sha: commit.tree },
    },
    author: null,
    committer: null,
    parents: commit.parents.map((p) => ({ sha: p })),
    html_url: `${origin}/${repo.fullName}/commit/${sha}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/commits/${sha}`,
  };
}

function refView(repo: Repo, ref: string, sha: string, origin: string): Record<string, unknown> {
  return {
    ref,
    node_id: `R_${sha}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
  };
}

function branchView(repo: Repo, name: string, sha: string, origin: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${origin}/api/v3/repos/${repo.fullName}/commits/${sha}` },
    protected: false,
  };
}

function paginate<T>(items: T[], query: Map<string, string>, origin: string, path: string): RestResult {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(pages)}>; rel="last"`);
  if (links.length > 0) headers.Link = links.join(', ');
  return ok(slice, 200, headers);
}

/** Resolve a directory path to its tree oid, or null when it is not a directory. */
function getDirTreeOid(objects: Map<string, GitObject>, rootTreeOid: string, path: string): string | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  let current = rootTreeOid;
  for (const part of parts) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const next = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!next) return null;
    current = next.oid;
  }
  return current;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** The REST v3 router. `segments` are the path parts after /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: Map<string, string>,
  body: unknown,
  origin: string,
): RestResult {
  const path = `/api/v3${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/ — root
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: `${origin}/api/v3/user`, authorizations_url: '', code_search_url: '', commit_search_url: '', emails_url: '', emojis_url: '', events_url: '', feeds_url: '', followers_url: '', following_url: '', gists_url: '', hub_url: '', issue_search_url: '', issues_url: '', keys_url: '', label_search_url: '', notifications_url: '', organization_repositories_url: '', organization_teams_url: '', organization_url: '', public_gists_url: '', rate_limit_url: '', repository_search_url: '', repository_url: '', star_url: '', user_repositories_url: `${origin}/api/v3/user/repos`, user_search_url: '', user_url: `${origin}/api/v3/user`, },
      200,
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '', hooks: [], git: [], pages: [], importer: [], api: [] });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: store.viewer.login, id: store.viewer.id, node_id: `U_${store.viewer.id}`, avatar_url: '', name: store.viewer.name, email: store.viewer.email, type: 'User', site_admin: false, html_url: `${origin}/${store.viewer.login}`, url: `${origin}/api/v3/users/${store.viewer.login}`, created_at: '2026-11-14T06:30:00Z', updated_at: '2026-11-14T06:30:00Z' });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) return err(422, 'name is required');
      const repo = store.createRepo(store.viewer.login, name, typeof b.description === 'string' ? b.description : '', b.private === true, typeof b.default_branch === 'string' ? b.default_branch : 'main');
      if (!repo) return err(422, 'name already exists on this account');
      return ok(repoView(store, repo, origin), 201);
    }
    if (method === 'GET') {
      const repos = store.listReposFor(store.viewer.login);
      return paginate(repos.map((r) => repoView(store, r, origin)), query, origin, path);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    const rest = segments.slice(3);
    const repo = store.getRepo(owner, repoName);
    if (!repo) return err(404, 'Not Found');

    // DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoView(store, repo, origin));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
        if (typeof b.private === 'boolean') repo.private = b.private;
        return ok(repoView(store, repo, origin));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /git/refs...
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method !== 'POST') return err(404, 'Not Found');
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref || !sha) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'object not found');
        repo.refs.set(ref, sha);
        store.touch(repo);
        return ok(refView(repo, ref, sha, origin), 201);
      }
      const refPath = rest.slice(2).join('/');
      const fullRef = `refs/${refPath}`;
      if (method === 'GET') {
        const sha = repo.refs.get(fullRef);
        if (!sha) return err(404, 'Not Found');
        return ok(refView(repo, fullRef, sha, origin));
      }
      if (method === 'PATCH') {
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!sha || !repo.objects.has(sha)) return err(422, 'object not found');
        repo.refs.set(fullRef, sha);
        store.touch(repo);
        return ok(refView(repo, fullRef, sha, origin));
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(fullRef)) return err(404, 'Not Found');
        repo.refs.delete(fullRef);
        store.touch(repo);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /git/commits/{sha}
    if (rest[0] === 'git' && rest[1] === 'commits' && rest.length === 3) {
      if (method !== 'GET') return err(404, 'Not Found');
      const view = commitView(repo, rest[2] as string, origin);
      if (!view) return err(404, 'Not Found');
      return ok(view);
    }

    // /git/trees/{sha}
    if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 3) {
      if (method !== 'GET') return err(404, 'Not Found');
      const sha = rest[2] as string;
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'tree') return err(404, 'Not Found');
      const recursive = query.get('recursive') === '1';
      const tree: Record<string, unknown>[] = [];
      const walk = (treeOid: string, prefix: string): void => {
        for (const e of parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0))) {
          const p = prefix ? `${prefix}/${e.name}` : e.name;
          const child = repo.objects.get(e.oid);
          tree.push({ path: p, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.oid, size: child?.type === 'blob' ? child.data.length : undefined, url: `${origin}/api/v3/repos/${repo.fullName}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}` });
          if (recursive && e.mode === '40000') walk(e.oid, p);
        }
      };
      walk(sha, '');
      return ok({ sha, url: `${origin}/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree, truncated: false });
    }

    // /branches
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) branches.push(branchView(repo, ref.slice('refs/heads/'.length), sha, origin));
        }
        branches.sort((a, c) => ((a.name as string) < (c.name as string) ? -1 : 1));
        return ok(branches);
      }
      if (rest.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, 'Not Found');
        return ok(branchView(repo, rest[1] as string, sha, origin));
      }
      return err(404, 'Not Found');
    }

    // /commits
    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (!tip) return ok([]);
        const list: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const view = commitView(repo, oid, origin);
          if (view) list.push(view);
          const c = getCommit(repo.objects, oid);
          if (c) stack.push(...c.parents);
        }
        return paginate(list, query, origin, path);
      }
      if (rest.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        const view = commitView(repo, rest[1] as string, origin);
        if (!view) return err(404, 'Not Found');
        return ok(view);
      }
      return err(404, 'Not Found');
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const ref = query.get('ref');
      const tip = ref ? store.resolveRef(repo, ref) : store.headOid(repo);
      const treeOid = tip ? getCommit(repo.objects, tip)?.tree ?? null : null;
      if (method === 'GET') {
        if (!treeOid) return err(404, 'Not Found');
        if (!filePath) {
          const flat = flattenTree(repo.objects, treeOid);
          const entries: Record<string, unknown>[] = [];
          const seenDirs = new Set<string>();
          for (const [p, v] of flat) {
            const first = p.split('/')[0] as string;
            if (p.includes('/')) {
              if (!seenDirs.has(first)) {
                seenDirs.add(first);
                entries.push({ type: 'dir', name: first, path: first, sha: '', size: 0, url: `${origin}/api/v3/repos/${repo.fullName}/contents/${first}`, html_url: `${origin}/${repo.fullName}/tree/${repo.defaultBranch}/${first}` });
              }
            } else {
              entries.push({ type: 'file', name: p, path: p, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0, url: `${origin}/api/v3/repos/${repo.fullName}/contents/${p}`, html_url: `${origin}/${repo.fullName}/blob/${repo.defaultBranch}/${p}` });
            }
          }
          entries.sort((a, c) => ((a.name as string) < (c.name as string) ? -1 : 1));
          return ok(entries);
        }
        const entry = getTreePath(repo.objects, treeOid, filePath);
        if (!entry) {
          // Maybe a directory: walk to its tree and list the entries directly under it.
          const dirTree = getDirTreeOid(repo.objects, treeOid, filePath);
          if (!dirTree) return err(404, 'Not Found');
          const dirEntries: Record<string, unknown>[] = [];
          for (const e of parseTree(repo.objects.get(dirTree)?.data ?? Buffer.alloc(0))) {
            const isDir = e.mode === '40000';
            const child = repo.objects.get(e.oid);
            dirEntries.push({
              type: isDir ? 'dir' : 'file',
              name: e.name,
              path: `${filePath}/${e.name}`,
              sha: e.oid,
              size: !isDir && child?.type === 'blob' ? child.data.length : 0,
              url: `${origin}/api/v3/repos/${repo.fullName}/contents/${filePath}/${e.name}`,
              html_url: `${origin}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${filePath}/${e.name}`,
            });
          }
          dirEntries.sort((a, c) => ((a.name as string) < (c.name as string) ? -1 : 1));
          return ok(dirEntries);
        }
        const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
        return ok({ type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: b64encode(data), sha: entry.oid, url: `${origin}/api/v3/repos/${repo.fullName}/contents/${filePath}`, html_url: `${origin}/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}` });
      }
      if (method === 'PUT') {
        const content = typeof b.content === 'string' ? b64decode(b.content) : null;
        if (content === null) return err(422, 'content is required');
        const message = typeof b.message === 'string' ? b.message : `Update ${filePath}`;
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        let tipOid = store.resolveRef(repo, branch);
        let branchExists = true;
        if (!tipOid) {
          // create the branch from the default tip (or unborn)
          branchExists = false;
          tipOid = store.headOid(repo);
        }
        const baseTree = tipOid ? getCommit(repo.objects, tipOid)?.tree ?? null : null;
        const existing = baseTree ? getTreePath(repo.objects, baseTree, filePath) : null;
        if (sha && existing && existing.oid !== sha) return err(409, 'sha does not match the current file');
        if (sha && !existing) return err(422, 'sha given but the file does not exist');
        const authorLine = `${store.viewer.name} <${store.viewer.email}> 0 +0000`;
        const newCommit = commitFile(repo.objects, tipOid, filePath, content, message, authorLine);
        repo.refs.set(`refs/heads/${branch}`, newCommit);
        store.touch(repo);
        const blobOid = hashObject('blob', content);
        // GitHub: 201 when the file is created, 200 when it is updated.
        return ok({ content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, url: `${origin}/api/v3/repos/${repo.fullName}/contents/${filePath}`, html_url: `${origin}/${repo.fullName}/blob/${branch}/${filePath}`, type: 'file', encoding: 'base64' }, commit: { sha: newCommit, message, url: `${origin}/api/v3/repos/${repo.fullName}/commits/${newCommit}` } }, existing ? 200 : 201);
      }
      if (method === 'DELETE') {
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        const message = typeof b.message === 'string' ? b.message : `Delete ${filePath}`;
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tipOid = store.resolveRef(repo, branch);
        if (!tipOid) return err(404, 'Not Found');
        const baseTree = getCommit(repo.objects, tipOid)?.tree ?? null;
        const existing = baseTree ? getTreePath(repo.objects, baseTree, filePath) : null;
        if (!existing) return err(404, 'Not Found');
        if (sha && existing.oid !== sha) return err(409, 'sha does not match the current file');
        const authorLine = `${store.viewer.name} <${store.viewer.email}> 0 +0000`;
        const newTree = setTreePath(repo.objects, baseTree, filePath, null, null);
        const newCommit = storeObject(repo.objects, 'commit', buildCommit(newTree, [tipOid], message, authorLine, authorLine));
        repo.refs.set(`refs/heads/${branch}`, newCommit);
        store.touch(repo);
        return ok({ content: null, commit: { sha: newCommit, message, url: `${origin}/api/v3/repos/${repo.fullName}/commits/${newCommit}` } });
      }
      return err(404, 'Not Found');
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') return ok([...repo.labels.values()].map(labelView));
        if (method === 'POST') {
          const name = typeof b.name === 'string' ? b.name : '';
          if (!name) return err(422, 'name is required');
          const label: Label = { name, color: typeof b.color === 'string' ? b.color : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
          repo.labels.set(name, label);
          return ok(labelView(label), 201);
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const labelsFilter = query.get('labels');
          if (labelsFilter) {
            const wanted = new Set(labelsFilter.split(','));
            list = list.filter((i) => i.labels.some((l) => wanted.has(l.name)));
          }
          list.sort((a, c) => {
            const cmp = sort === 'created' ? (a.number - c.number) : (a.number - c.number);
            return direction === 'asc' ? cmp : -cmp;
          });
          return paginate(list.map((i) => issueView(store, repo, i, origin)), query, origin, path);
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required');
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labelNames: string[] = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
          for (const name of labelNames) {
            if (!repo.labels.has(name)) return err(422, `label does not exist: ${name}`);
          }
          const issue = store.createIssue(repo, title, bodyText, labelNames);
          if (!issue) return err(422, 'label does not exist');
          return ok(issueView(store, repo, issue, origin), 201);
        }
        return err(404, 'Not Found');
      }
      // /issues/comments/{id}
      if (rest.length === 3 && rest[1] === 'comments') {
        const commentId = parseNumber(rest[2]);
        if (commentId === null) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        for (const [number, list] of repo.comments) {
          const c = list.find((x) => x.id === commentId);
          if (c) return ok(commentView(store, repo, number, c, origin));
        }
        return err(404, 'Not Found');
      }
      const number = parseNumber(rest[1]);
      if (number === null) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === number);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(issueView(store, repo, issue, origin));
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? store.nowIso() : null;
          }
          if (Array.isArray(b.labels)) {
            const labelNames = (b.labels as unknown[]).filter((x) => typeof x === 'string') as string[];
            const labels: Label[] = [];
            for (const name of labelNames) {
              const label = repo.labels.get(name);
              if (!label) return err(422, `label does not exist: ${name}`);
              labels.push(label);
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          return ok(issueView(store, repo, issue, origin));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          return ok(comments.map((c) => commentView(store, repo, number, c, origin)));
        }
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          if (!bodyText) return err(422, 'body is required');
          const comment = store.addComment(repo, number, bodyText);
          return ok(commentView(store, repo, number, comment, origin), 201);
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.number - a.number);
          return paginate(list.map((p) => pullView(store, repo, p, origin)), query, origin, path);
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          if (!title || !head) return err(422, 'title and head are required');
          const result = store.createPull(repo, title, typeof b.body === 'string' ? b.body : '', head, base);
          if ('error' in result) return err(422, result.error);
          return ok(pullView(store, repo, result, origin), 201);
        }
        return err(404, 'Not Found');
      }
      const number = parseNumber(rest[1]);
      if (number === null) return err(404, 'Not Found');
      const pull = repo.pulls.find((p) => p.number === number);
      if (rest.length === 2) {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(pullView(store, repo, pull, origin));
        if (method === 'PATCH') {
          if (typeof b.title === 'string') pull.title = b.title;
          if (typeof b.body === 'string') pull.body = b.body;
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            pull.state = b.state;
            pull.closedAt = b.state === 'closed' ? store.nowIso() : null;
          }
          pull.updatedAt = store.nowIso();
          return ok(pullView(store, repo, pull, origin));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        const baseTip = store.resolveRef(repo, pull.base.ref);
        const headTip = pull.head.sha;
        const baseCommit = baseTip ? getCommit(repo.objects, baseTip) : null;
        const headCommit = getCommit(repo.objects, headTip);
        const files = diffTrees(repo.objects, baseCommit?.tree ?? null, headCommit?.tree ?? null);
        return ok(files.map((f) => ({ sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull Request is not mergeable');
        const methodName = typeof b.merge_method === 'string' ? b.merge_method : 'merge';
        const baseTip = store.resolveRef(repo, pull.base.ref);
        const headTip = pull.head.sha;
        if (!baseTip || !headTip) return err(404, 'Not Found');
        const baseCommit = getCommit(repo.objects, baseTip);
        if (!baseCommit) return err(404, 'Not Found');
        const base = mergeBase(repo.objects, baseTip, headTip);
        const merged = threeWayMerge(repo.objects, base, baseTip, headTip);
        if (merged.conflict) return err(405, 'Merge conflict');
        const authorLine = `${store.viewer.name} <${store.viewer.email}> 0 +0000`;
        let mergeCommit: string;
        if (methodName === 'squash') {
          const message = `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd();
          mergeCommit = storeObject(repo.objects, 'commit', buildCommit(merged.tree, [baseTip], message, authorLine, authorLine));
        } else {
          const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}`;
          mergeCommit = storeObject(repo.objects, 'commit', buildCommit(merged.tree, [baseTip, headTip], message, authorLine, authorLine));
        }
        repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommit);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.nowIso();
        pull.mergeCommitSha = mergeCommit;
        pull.closedAt = pull.mergedAt;
        pull.updatedAt = store.nowIso();
        return ok({ sha: mergeCommit, merged: true, message: methodName === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head.ref}` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
