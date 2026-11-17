// MCP (Model Context Protocol) over Streamable HTTP: plain JSON answers, no SSE.
// Supports the 2026-07-28 `server/discover` era and the legacy `initialize`
// handshake. Tools: create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request.

import { getCommit, mergeBase, threeWayMerge, buildCommit, storeObject } from './git.ts';
import { Store } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Synonym lookup: the suite maps documented names to schema properties. */
function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function toolResult(obj: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError,
  };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function handleMcp(store: Store, origin: string, body: unknown, rawBody: Buffer): McpResult {
  // A body that is not JSON -> HTTP 400 with JSON-RPC parse error -32700.
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as JsonRpcRequest;
  } catch {
    return { status: 400, body: rpcError(424242, -32700, 'Parse error') };
  }
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return { status: 400, body: rpcError(424242, -32700, 'Parse error') };
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: {},
        },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }

  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // Notifications have no id; answer 202 with no body.
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      body: rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }),
    };
  }

  if (method === 'tools/call') {
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name || !TOOL_MAP.has(name)) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name ?? ''}`) };
    }
    const tool = TOOL_MAP.get(name) as ToolDef;
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null);
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(id, toolResult({ error: `missing required arguments: ${missing.join(', ')}` }, true)) };
    }
    try {
      const result = callTool(store, origin, name, args);
      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        return { status: 200, body: rpcResult(id, toolResult(result, true)) };
      }
      return { status: 200, body: rpcResult(id, toolResult(result)) };
    } catch (e) {
      return { status: 200, body: rpcResult(id, toolResult({ error: (e as Error).message }, true)) };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

function callTool(store: Store, origin: string, name: string, args: Record<string, unknown>): unknown {
  const viewer = store.viewerUser();
  if (name === 'create_repo') {
    const repoName = pickArg(args, 'name', 'repo', 'repository') as string;
    const description = (pickArg(args, 'description') as string | undefined) ?? '';
    const isPrivate = (pickArg(args, 'private') as boolean | undefined) ?? false;
    const repo = store.createRepo(store.viewer.login, repoName, description, isPrivate);
    if (!repo) return { error: 'name already exists on this account' };
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: viewer.id },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `${origin}/${repo.fullName}`,
      url: `${origin}/api/v3/repos/${repo.fullName}`,
    };
  }

  const owner = (pickArg(args, 'owner', 'owner_login') as string | undefined) ?? '';
  const repoName = (pickArg(args, 'repo', 'repository', 'name') as string | undefined) ?? '';
  // full_name "owner/repo" support
  let o = owner;
  let r = repoName;
  const fullName = pickArg(args, 'full_name') as string | undefined;
  if (fullName && fullName.includes('/')) {
    const [fo, fr] = fullName.split('/');
    o = o || (fo as string);
    r = r || (fr as string);
  }
  const repo = store.getRepo(o, r);
  if (!repo) return { error: 'Not Found' };

  if (name === 'get_repo') {
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: viewer.id },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `${origin}/${repo.fullName}`,
      url: `${origin}/api/v3/repos/${repo.fullName}`,
    };
  }

  if (name === 'create_issue') {
    const title = pickArg(args, 'title') as string;
    const bodyText = (pickArg(args, 'body') as string | undefined) ?? '';
    const labelNames: string[] = Array.isArray(args.labels) ? (args.labels as unknown[]).filter((x) => typeof x === 'string') as string[] : [];
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName)) return { error: `label does not exist: ${labelName}` };
    }
    const issue = store.createIssue(repo, title, bodyText, labelNames);
    if (!issue) return { error: 'label does not exist' };
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
      user: { login: issue.user.login, id: issue.user.id },
      html_url: `${origin}/${repo.fullName}/issues/${issue.number}`,
      url: `${origin}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    };
  }

  if (name === 'list_issues') {
    const state = (pickArg(args, 'state') as string | undefined) ?? 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return list.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
      user: { login: i.user.login, id: i.user.id },
      html_url: `${origin}/${repo.fullName}/issues/${i.number}`,
      url: `${origin}/api/v3/repos/${repo.fullName}/issues/${i.number}`,
    }));
  }

  if (name === 'create_pull_request') {
    const title = pickArg(args, 'title') as string;
    const head = pickArg(args, 'head', 'head_ref') as string;
    const base = (pickArg(args, 'base', 'base_ref') as string | undefined) ?? repo.defaultBranch;
    const bodyText = (pickArg(args, 'body') as string | undefined) ?? '';
    const result = store.createPull(repo, title, bodyText, head, base);
    if ('error' in result) return { error: result.error };
    return {
      id: result.id,
      number: result.number,
      title: result.title,
      body: result.body,
      state: result.state,
      head: { ref: result.head.ref, sha: result.head.sha },
      base: { ref: result.base.ref, sha: result.base.sha },
      html_url: `${origin}/${repo.fullName}/pull/${result.number}`,
      url: `${origin}/api/v3/repos/${repo.fullName}/pulls/${result.number}`,
    };
  }

  if (name === 'merge_pull_request') {
    const pullNumber = Number(pickArg(args, 'pull_number', 'number', 'pullNumber'));
    const pull = repo.pulls.find((p) => p.number === pullNumber);
    if (!pull) return { error: 'Not Found' };
    if (pull.state !== 'open') return { error: 'Pull Request is not mergeable' };
    const baseTip = store.resolveRef(repo, pull.base.ref);
    const headTip = pull.head.sha;
    if (!baseTip || !headTip) return { error: 'base or head ref not found' };
    const base = mergeBase(repo.objects, baseTip, headTip);
    const merged = threeWayMerge(repo.objects, base, baseTip, headTip);
    if (merged.conflict) return { error: 'Merge conflict' };
    const authorLine = `${store.viewer.name} <${store.viewer.email}> 0 +0000`;
    const mergeCommit = storeObject(repo.objects, 'commit', buildCommit(merged.tree, [baseTip], `${pull.title} (#${pull.number})`, authorLine, authorLine));
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = mergeCommit;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = store.nowIso();
    return { sha: mergeCommit, merged: true, message: `${pull.title} (#${pull.number})` };
  }

  return { error: `Unknown tool: ${name}` };
}

export { getCommit };
