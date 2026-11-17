// In-memory data model for the forge. Everything lives in Maps; no fs writes in
// the hot path. Deterministic: no wall-clock time in state — a logical clock
// (monotonic tick) supplies created/updated timestamps.

import { viewerIdentity, type ScenarioUser } from './scenario.ts';
import { ZERO_OID, type GitObject } from './git.ts';

export interface UserInfo {
  login: string;
  id: number;
  name?: string;
  email?: string;
  type?: string;
}

export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserInfo;
  assignees: UserInfo[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** Bumped on every git mutation; the fetch pack cache keys on it. */
  version: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

const BASE_EPOCH_MS = Date.UTC(2026, 10, 14, 6, 30, 0);

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;
  tick = 0;
  viewer: ScenarioUser;
  teammates: ScenarioUser[];

  constructor() {
    this.viewer = viewerIdentity();
    this.teammates = [this.viewer];
  }

  /** Logical clock: deterministic ISO timestamps, one second per tick. */
  nowIso(): string {
    this.tick += 1;
    return new Date(BASE_EPOCH_MS + this.tick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  viewerUser(): UserInfo {
    return { login: this.viewer.login, id: this.viewer.id, name: this.viewer.name, email: this.viewer.email, type: 'User' };
  }

  userFor(login: string): UserInfo {
    if (login === this.viewer.login) return this.viewerUser();
    return { login, id: 0, type: 'User' };
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false, defaultBranch = 'main'): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch,
      createdSeq: this.seq++,
      version: 0,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: now,
      updatedAt: now,
    };
    // Seed the six standard labels (the scenario's labels are created on demand
    // by the checks, but the defaults make the forge behave like GitHub).
    for (const [name, color] of [
      ['bug', 'd73a4a'],
      ['enhancement', 'a2eeef'],
      ['documentation', '0075ca'],
      ['question', 'd876e3'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
    ] as const) {
      repo.labels.set(name, { name, color });
    }
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  /** Mark a repo as changed (git objects or refs mutated). */
  touch(repo: Repo): void {
    repo.version += 1;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  headOid(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Resolve a ref name (branch, full ref, or sha) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return tag;
    return null;
  }

  /** Resolve a ref name to the object oid a git client would fetch (peeled for tags). */
  resolveRefPeeled(repo: Repo, ref: string): string | null {
    const oid = this.resolveRef(repo, ref);
    if (!oid) return null;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) return m[1] as string;
    }
    return oid;
  }

  nextIssueNumber(repo: Repo): number {
    return repo.nextNumber++;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | null {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return null;
      labels.push(label);
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextNumber,
      number: this.nextIssueNumber(repo),
      title,
      body,
      state: 'open',
      labels,
      user: this.viewerUser(),
      assignees: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (!headSha || !baseSha) return { error: 'base or head ref not found' };
    for (const p of repo.pulls) {
      if (p.state === 'open' && p.head.ref === headRef && p.base.ref === baseRef) {
        return { error: 'a pull request already exists for these branches' };
      }
    }
    const now = this.nowIso();
    const pull: Pull = {
      id: repo.id * 100000 + repo.nextNumber,
      number: this.nextIssueNumber(repo),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: headRef, sha: headSha, label: `${repo.owner}:${headRef}` },
      base: { ref: baseRef, sha: baseSha, label: `${repo.owner}:${baseRef}` },
      user: this.viewerUser(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findIssueOrPull(repo: Repo, number: number): Issue | Pull | null {
    return repo.issues.find((i) => i.number === number) ?? repo.pulls.find((p) => p.number === number) ?? null;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const now = this.nowIso();
    const comment: Comment = { id: repo.nextCommentId++, body, user: this.viewerUser(), createdAt: now, updatedAt: now };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }
}

export { ZERO_OID };
