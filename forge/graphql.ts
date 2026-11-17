// A small GraphQL parser + executor for the fixed document set the conformance
// suite uses (queries, mutations, aliases, inline fragments, __type, batching).
// It is not a general GraphQL server: it covers the operations the checks send.

import { buildCommit, diffTrees, getCommit, mergeBase, storeObject, threeWayMerge, ZERO_OID } from './git.ts';
import { Store, type Issue, type Pull, type Repo, type Comment } from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc] ?? esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variables, selectionSet };
  }

  private parseType(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      // fragment spread — not used by the suite; parse the name and skip
      this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: '', selectionSet: [] };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg ? resolveValue(arg.value, variables) : undefined;
}

// ---------------------------------------------------------------- global ids

export function encodeGlobalId(kind: string, ref: string): string {
  return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; ref: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), ref: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- type metadata

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'headRef', 'baseRef', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  origin: string;
}

type AnyObj = Record<string, unknown> & { __typename: string };

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}

function userObj(login: string, id: number, name?: string, email?: string): AnyObj {
  return { __typename: 'User', login, id, name, email };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function paginate<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string') {
    const idx = decodeCursor(after);
    if (idx !== null) start = idx + 1;
  }
  const count = typeof first === 'number' ? first : items.length;
  const nodes = items.slice(start, start + count);
  const end = start + nodes.length;
  return { nodes, hasNextPage: end < items.length, endCursor: nodes.length > 0 ? encodeCursor(end - 1) : null };
}

function resolveSelection(
  parentType: string,
  parent: AnyObj,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === '' || sel.typeCondition === parent.__typename) {
        Object.assign(out, resolveSelection(parentType, parent, sel.selectionSet, variables, ctx, errors));
      }
      continue;
    }
    const field = sel;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parent.__typename;
      continue;
    }
    const value = resolveField(parentType, parent, field, variables, ctx, errors);
    out[key] = value;
  }
  return out;
}

function resolveField(
  parentType: string,
  parent: AnyObj,
  field: FieldNode,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: { message: string }[],
): unknown {
  const { store, origin } = ctx;
  const sub = (value: AnyObj | null, selectionSet?: SelectionNode[]): unknown => {
    if (value === null) return null;
    if (!selectionSet) return value;
    return resolveSelection(value.__typename, value, selectionSet, variables, ctx, errors);
  };
  const unknown = (): null => {
    errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  };

  // ---- Query
  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      const v = store.viewer;
      return sub(userObj(v.login, v.id, v.name, v.email), field.selectionSet);
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', variables) as string | undefined;
      const name = argValue(field, 'name', variables) as string | undefined;
      if (!owner || !name) return null;
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return sub(repoObj(repo), field.selectionSet);
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', variables) as string | undefined;
      if (!id) return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      const [kind, ref] = [decoded.kind, decoded.ref];
      if (kind === 'Repository') {
        const [owner, name] = ref.split('/');
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return sub(repoObj(repo), field.selectionSet);
      }
      if (kind === 'Issue' || kind === 'PullRequest') {
        const parts = ref.split('/');
        const owner = parts[0] as string;
        const name = parts[1] as string;
        const number = Number.parseInt(parts[2] as string, 10);
        const repo = store.getRepo(owner, name);
        if (!repo) return null;
        if (kind === 'Issue') {
          const issue = repo.issues.find((i) => i.number === number);
          if (!issue) return null;
          return sub(issueObj(repo, issue), field.selectionSet);
        }
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return null;
        return sub(pullObj(repo, pull), field.selectionSet);
      }
      if (kind === 'User') {
        return sub(userObj(ref, 0), field.selectionSet);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = argValue(field, 'name', variables) as string | undefined;
      if (!name) return null;
      const typeObj: AnyObj = { __typename: '__Type', typeName: name };
      return sub(typeObj, field.selectionSet);
    }
    if (field.name === '__schema') {
      const schemaObj: AnyObj = { __typename: '__Schema' };
      return sub(schemaObj, field.selectionSet);
    }
    return unknown();
  }

  // ---- Mutation
  if (parentType === 'Mutation') {
    const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repoId = input.repositoryId as string | undefined;
      const decoded = repoId ? decodeGlobalId(repoId) : null;
      if (!decoded || decoded.kind !== 'Repository') return sub({ __typename: 'CreateIssuePayload', issue: null }, field.selectionSet);
      const [owner, name] = decoded.ref.split('/');
      const repo = owner && name ? store.getRepo(owner, name) : undefined;
      if (!repo) return sub({ __typename: 'CreateIssuePayload', issue: null }, field.selectionSet);
      const issue = store.createIssue(repo, (input.title as string) ?? '', (input.body as string) ?? '', []);
      const payload: AnyObj = { __typename: 'CreateIssuePayload', issue: issue ? issueObj(repo, issue) : null };
      return sub(payload, field.selectionSet);
    }
    if (field.name === 'closeIssue') {
      const issueId = input.issueId as string | undefined;
      const decoded = issueId ? decodeGlobalId(issueId) : null;
      if (!decoded || decoded.kind !== 'Issue') return sub({ __typename: 'CloseIssuePayload', issue: null }, field.selectionSet);
      const parts = decoded.ref.split('/');
      const repo = store.getRepo(parts[0] as string, parts[1] as string);
      const issue = repo?.issues.find((i) => i.number === Number.parseInt(parts[2] as string, 10));
      if (!issue) return sub({ __typename: 'CloseIssuePayload', issue: null }, field.selectionSet);
      issue.state = 'closed';
      issue.closedAt = store.nowIso();
      issue.updatedAt = store.nowIso();
      const payload: AnyObj = { __typename: 'CloseIssuePayload', issue: issueObj(repo as Repo, issue) };
      return sub(payload, field.selectionSet);
    }
    if (field.name === 'createPullRequest') {
      const repoId = input.repositoryId as string | undefined;
      const decoded = repoId ? decodeGlobalId(repoId) : null;
      if (!decoded || decoded.kind !== 'Repository') return sub({ __typename: 'CreatePullRequestPayload', pullRequest: null }, field.selectionSet);
      const [owner, name] = decoded.ref.split('/');
      const repo = owner && name ? store.getRepo(owner, name) : undefined;
      if (!repo) return sub({ __typename: 'CreatePullRequestPayload', pullRequest: null }, field.selectionSet);
      const result = store.createPull(repo, (input.title as string) ?? '', (input.body as string) ?? '', (input.headRefName as string) ?? '', (input.baseRefName as string) ?? repo.defaultBranch);
      if ('error' in result) {
        errors.push({ message: result.error });
        return sub({ __typename: 'CreatePullRequestPayload', pullRequest: null }, field.selectionSet);
      }
      const payload: AnyObj = { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, result) };
      return sub(payload, field.selectionSet);
    }
    if (field.name === 'mergePullRequest') {
      const prId = input.pullRequestId as string | undefined;
      const decoded = prId ? decodeGlobalId(prId) : null;
      if (!decoded || decoded.kind !== 'PullRequest') return sub({ __typename: 'MergePullRequestPayload', pullRequest: null }, field.selectionSet);
      const parts = decoded.ref.split('/');
      const repo = store.getRepo(parts[0] as string, parts[1] as string);
      const pull = repo?.pulls.find((p) => p.number === Number.parseInt(parts[2] as string, 10));
      if (!repo || !pull) return sub({ __typename: 'MergePullRequestPayload', pullRequest: null }, field.selectionSet);
      if (pull.state !== 'open') {
        errors.push({ message: 'Pull request is not open' });
        return sub({ __typename: 'MergePullRequestPayload', pullRequest: null }, field.selectionSet);
      }
      const baseTip = store.resolveRef(repo, pull.base.ref);
      const headTip = pull.head.sha;
      if (!baseTip || !headTip) {
        errors.push({ message: 'base or head ref not found' });
        return sub({ __typename: 'MergePullRequestPayload', pullRequest: null }, field.selectionSet);
      }
      const base = mergeBase(repo.objects, baseTip, headTip);
      const merged = threeWayMerge(repo.objects, base, baseTip, headTip);
      if (merged.conflict) {
        errors.push({ message: 'Merge conflict' });
        return sub({ __typename: 'MergePullRequestPayload', pullRequest: null }, field.selectionSet);
      }
      const authorLine = `${store.viewer.name} <${store.viewer.email}> 0 +0000`;
      const method = (input.mergeMethod as string) ?? 'SQUASH';
      let mergeCommit: string;
      if (method === 'SQUASH') {
        mergeCommit = storeObject(repo.objects, 'commit', buildCommit(merged.tree, [baseTip], `${pull.title} (#${pull.number})`, authorLine, authorLine));
      } else {
        mergeCommit = storeObject(repo.objects, 'commit', buildCommit(merged.tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.head.ref}`, authorLine, authorLine));
      }
      repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommit);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.nowIso();
      pull.mergeCommitSha = mergeCommit;
      pull.closedAt = pull.mergedAt;
      pull.updatedAt = store.nowIso();
      const payload: AnyObj = { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
      return sub(payload, field.selectionSet);
    }
    if (field.name === 'addComment') {
      const subjectId = input.subjectId as string | undefined;
      const decoded = subjectId ? decodeGlobalId(subjectId) : null;
      if (!decoded || decoded.kind !== 'Issue') return sub({ __typename: 'AddCommentPayload', commentEdge: null }, field.selectionSet);
      const parts = decoded.ref.split('/');
      const repo = store.getRepo(parts[0] as string, parts[1] as string);
      const number = Number.parseInt(parts[2] as string, 10);
      const issue = repo?.issues.find((i) => i.number === number);
      if (!repo || !issue) return sub({ __typename: 'AddCommentPayload', commentEdge: null }, field.selectionSet);
      const comment = store.addComment(repo, number, (input.body as string) ?? '');
      const commentObj: AnyObj = { __typename: 'IssueComment', repo, number, comment };
      const payload: AnyObj = { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentObj } };
      return sub(payload, field.selectionSet);
    }
    return unknown();
  }

  // ---- Repository
  if (parentType === 'Repository') {
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id': return encodeGlobalId('Repository', repo.fullName);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'url': return `${origin}/${repo.fullName}`;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'owner': return sub(userObj(repo.owner, store.viewer.id), field.selectionSet);
      case 'defaultBranchRef': {
        const headOid = store.headOid(repo);
        if (!headOid) return null;
        const refObj: AnyObj = { __typename: 'Ref', name: repo.defaultBranch, oid: headOid, repo };
        return sub(refObj, field.selectionSet);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = argValue(field, 'number', variables) as number | undefined;
        if (number === undefined) return null;
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return sub(issueObj(repo, issue), field.selectionSet);
      }
      case 'issues': {
        const states = argValue(field, 'states', variables) as string[] | undefined;
        const orderBy = (argValue(field, 'orderBy', variables) ?? {}) as Record<string, unknown>;
        let list = [...repo.issues];
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
          list = list.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => (a.number - b.number) * direction);
        const page = paginate(list, argValue(field, 'first', variables), argValue(field, 'after', variables));
        const conn: AnyObj = { __typename: 'IssueConnection', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: list.length };
        return sub(conn, field.selectionSet);
      }
      case 'pullRequests': {
        const states = argValue(field, 'states', variables) as string[] | undefined;
        let list = [...repo.pulls];
        if (states && states.length > 0) {
          const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : 'merged')));
          list = list.filter((p) => wanted.has(pullState(p) === 'MERGED' ? 'merged' : p.state));
        }
        const page = paginate(list, argValue(field, 'first', variables), argValue(field, 'after', variables));
        const conn: AnyObj = { __typename: 'PullRequestConnection', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: list.length };
        return sub(conn, field.selectionSet);
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', variables) as number | undefined;
        if (number === undefined) return null;
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return null;
        return sub(pullObj(repo, pull), field.selectionSet);
      }
      default: return unknown();
    }
  }

  // ---- Issue
  if (parentType === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (field.name) {
      case 'id': return encodeGlobalId('Issue', `${repo.fullName}/${issue.number}`);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issueState(issue);
      case 'url': return `${origin}/${repo.fullName}/issues/${issue.number}`;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'author': return sub(userObj(issue.user.login, issue.user.id), field.selectionSet);
      case 'repository': return sub(repoObj(repo), field.selectionSet);
      case 'labels': {
        const labelNodes = issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color }));
        const conn: AnyObj = { __typename: 'LabelConnection', nodes: labelNodes, hasNextPage: false, endCursor: null, totalCount: labelNodes.length };
        return sub(conn, field.selectionSet);
      }
      case 'comments': {
        const comments = repo.comments.get(issue.number) ?? [];
        const page = paginate(comments, argValue(field, 'first', variables), argValue(field, 'after', variables));
        const conn: AnyObj = { __typename: 'IssueCommentConnection', repo, number: issue.number, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: comments.length };
        return sub(conn, field.selectionSet);
      }
      default: return unknown();
    }
  }

  // ---- PullRequest
  if (parentType === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field.name) {
      case 'id': return encodeGlobalId('PullRequest', `${repo.fullName}/${pull.number}`);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAt;
      case 'url': return `${origin}/${repo.fullName}/pull/${pull.number}`;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'closedAt': return pull.closedAt;
      case 'headRefName': return pull.head.ref;
      case 'baseRefName': return pull.base.ref;
      case 'author': return sub(userObj(pull.user.login, pull.user.id), field.selectionSet);
      case 'repository': return sub(repoObj(repo), field.selectionSet);
      case 'headRef': {
        const refObj: AnyObj = { __typename: 'Ref', name: pull.head.ref, oid: pull.head.sha, repo };
        return sub(refObj, field.selectionSet);
      }
      case 'baseRef': {
        const refObj: AnyObj = { __typename: 'Ref', name: pull.base.ref, oid: pull.base.sha, repo };
        return sub(refObj, field.selectionSet);
      }
      case 'mergeCommit': {
        if (!pull.mergeCommitSha) return null;
        const commitObj: AnyObj = { __typename: 'Commit', oid: pull.mergeCommitSha, repo };
        return sub(commitObj, field.selectionSet);
      }
      case 'mergeable': {
        const baseTip = store.resolveRef(repo, pull.base.ref);
        const headTip = pull.head.sha;
        if (!baseTip || !headTip) return 'UNKNOWN';
        const base = mergeBase(repo.objects, baseTip, headTip);
        const merged = threeWayMerge(repo.objects, base, baseTip, headTip);
        return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const baseTip = store.resolveRef(repo, pull.base.ref);
        const headTip = pull.head.sha;
        const baseCommit = baseTip ? getCommit(repo.objects, baseTip) : null;
        const headCommit = getCommit(repo.objects, headTip);
        const changes = diffTrees(repo.objects, baseCommit?.tree ?? null, headCommit?.tree ?? null);
        const page = paginate(changes, argValue(field, 'first', variables), argValue(field, 'after', variables));
        const conn: AnyObj = { __typename: 'PullRequestFileConnection', nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor, totalCount: changes.length };
        return sub(conn, field.selectionSet);
      }
      default: return unknown();
    }
  }

  // ---- User
  if (parentType === 'User') {
    switch (field.name) {
      case 'id': return encodeGlobalId('User', parent.login as string);
      case 'databaseId': return parent.id as number;
      case 'login': return parent.login as string;
      case 'name': return (parent.name as string | undefined) ?? null;
      case 'email': return (parent.email as string | undefined) ?? null;
      case 'url': return `${origin}/${parent.login as string}`;
      default: return unknown();
    }
  }

  // ---- Ref
  if (parentType === 'Ref') {
    switch (field.name) {
      case 'id': return encodeGlobalId('Ref', `${(parent.repo as Repo).fullName}/${parent.name as string}`);
      case 'name': return parent.name as string;
      case 'prefix': return 'refs/heads/';
      case 'target': {
        const commitObj: AnyObj = { __typename: 'Commit', oid: parent.oid as string, repo: parent.repo as Repo };
        return sub(commitObj, field.selectionSet);
      }
      default: return unknown();
    }
  }

  // ---- Commit
  if (parentType === 'Commit') {
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id': return encodeGlobalId('Commit', `${repo.fullName}/${parent.oid as string}`);
      case 'oid': return parent.oid as string;
      case 'abbreviatedOid': return (parent.oid as string).slice(0, 7);
      case 'message': {
        const c = getCommit(repo.objects, parent.oid as string);
        return c ? c.message : null;
      }
      default: return unknown();
    }
  }

  // ---- Connections
  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'IssueCommentConnection' || parentType === 'PullRequestFileConnection' || parentType === 'LabelConnection') {
    switch (field.name) {
      case 'totalCount': return parent.totalCount as number;
      case 'nodes': {
        const nodes = parent.nodes as unknown[];
        if (!field.selectionSet) return nodes;
        return nodes.map((n) => {
          if (parentType === 'IssueConnection') return sub(issueObj(parent.repo as Repo, n as Issue), field.selectionSet);
          if (parentType === 'PullRequestConnection') return sub(pullObj(parent.repo as Repo, n as Pull), field.selectionSet);
          if (parentType === 'IssueCommentConnection') {
            const commentObj: AnyObj = { __typename: 'IssueComment', repo: parent.repo as Repo, number: parent.number as number, comment: n as Comment };
            return sub(commentObj, field.selectionSet);
          }
          if (parentType === 'PullRequestFileConnection') {
            const fileObj: AnyObj = { __typename: 'PullRequestFile', file: n };
            return sub(fileObj, field.selectionSet);
          }
          return sub(n as AnyObj, field.selectionSet);
        });
      }
      case 'edges': {
        const nodes = parent.nodes as unknown[];
        if (!field.selectionSet) return nodes.map((n) => ({ node: n }));
        return nodes.map((n) => {
          const edge: AnyObj = { __typename: 'Edge', cursor: '', node: null };
          const nodeSel = field.selectionSet?.find((s) => s.kind === 'field' && s.name === 'node') as FieldNode | undefined;
          if (nodeSel) {
            if (parentType === 'IssueConnection') edge.node = sub(issueObj(parent.repo as Repo, n as Issue), nodeSel.selectionSet);
            else if (parentType === 'PullRequestConnection') edge.node = sub(pullObj(parent.repo as Repo, n as Pull), nodeSel.selectionSet);
            else if (parentType === 'IssueCommentConnection') {
              const commentObj: AnyObj = { __typename: 'IssueComment', repo: parent.repo as Repo, number: parent.number as number, comment: n as Comment };
              edge.node = sub(commentObj, nodeSel.selectionSet);
            } else if (parentType === 'PullRequestFileConnection') {
              const fileObj: AnyObj = { __typename: 'PullRequestFile', file: n };
              edge.node = sub(fileObj, nodeSel.selectionSet);
            } else edge.node = sub(n as AnyObj, nodeSel.selectionSet);
          }
          const cursorSel = field.selectionSet?.find((s) => s.kind === 'field' && s.name === 'cursor');
          if (cursorSel) edge.cursor = '';
          return edge;
        });
      }
      case 'pageInfo': {
        const pageInfo: AnyObj = { __typename: 'PageInfo', hasNextPage: parent.hasNextPage as boolean, hasPreviousPage: false, startCursor: null, endCursor: parent.endCursor as string | null };
        return sub(pageInfo, field.selectionSet);
      }
      default: return unknown();
    }
  }

  // ---- PageInfo
  if (parentType === 'PageInfo') {
    switch (field.name) {
      case 'hasNextPage': return parent.hasNextPage as boolean;
      case 'hasPreviousPage': return parent.hasPreviousPage as boolean;
      case 'startCursor': return parent.startCursor as string | null;
      case 'endCursor': return parent.endCursor as string | null;
      default: return unknown();
    }
  }

  // ---- Label
  if (parentType === 'Label') {
    switch (field.name) {
      case 'id': return encodeGlobalId('Label', parent.name as string);
      case 'name': return parent.name as string;
      case 'color': return parent.color as string;
      default: return unknown();
    }
  }

  // ---- IssueComment
  if (parentType === 'IssueComment') {
    const comment = parent.comment as Comment;
    switch (field.name) {
      case 'id': return encodeGlobalId('IssueComment', `${(parent.repo as Repo).fullName}/${parent.number as number}/${comment.id}`);
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'author': return sub(userObj(comment.user.login, comment.user.id), field.selectionSet);
      case 'createdAt': return comment.createdAt;
      case 'updatedAt': return comment.updatedAt;
      case 'url': return `${origin}/${(parent.repo as Repo).fullName}/issues/${parent.number as number}#issuecomment-${comment.id}`;
      default: return unknown();
    }
  }

  // ---- PullRequestFile
  if (parentType === 'PullRequestFile') {
    const file = parent.file as { filename: string; status: string; additions: number; deletions: number; changes: number };
    switch (field.name) {
      case 'path': return file.filename;
      case 'additions': return file.additions;
      case 'deletions': return file.deletions;
      case 'changeType': return file.status.toUpperCase();
      default: return unknown();
    }
  }

  // ---- __Type / __Field / __EnumValue / __Schema
  if (parentType === '__Type') {
    const typeName = parent.typeName as string;
    switch (field.name) {
      case 'name': return typeName;
      case 'kind': return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      case 'fields': {
        const fields = TYPE_FIELDS[typeName] ?? [];
        const nodes = fields.map((name) => ({ __typename: '__Field', name }));
        if (!field.selectionSet) return nodes;
        return nodes.map((n) => sub(n, field.selectionSet));
      }
      case 'enumValues': {
        const values = ENUM_VALUES[typeName] ?? [];
        const nodes = values.map((name) => ({ __typename: '__EnumValue', name }));
        if (!field.selectionSet) return nodes;
        return nodes.map((n) => sub(n, field.selectionSet));
      }
      default: return unknown();
    }
  }
  if (parentType === '__Field') {
    if (field.name === 'name') return parent.name as string;
    return unknown();
  }
  if (parentType === '__EnumValue') {
    if (field.name === 'name') return parent.name as string;
    return unknown();
  }
  if (parentType === '__Schema') {
    if (field.name === 'queryType') return sub({ __typename: '__Type', typeName: 'Query' }, field.selectionSet);
    if (field.name === 'mutationType') return sub({ __typename: '__Type', typeName: 'Mutation' }, field.selectionSet);
    if (field.name === 'types') return [];
    return unknown();
  }

  // ---- Payloads and edges
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issue = parent.issue as AnyObj | null;
      return issue ? sub(issue, field.selectionSet) : null;
    }
    return unknown();
  }
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = parent.pullRequest as AnyObj | null;
      return pull ? sub(pull, field.selectionSet) : null;
    }
    return unknown();
  }
  if (parentType === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const edge = parent.commentEdge as AnyObj | null;
      if (!edge) return null;
      return sub(edge, field.selectionSet);
    }
    return unknown();
  }
  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const node = parent.node as AnyObj;
      return sub(node, field.selectionSet);
    }
    if (field.name === 'cursor') return '';
    return unknown();
  }
  if (parentType === 'Edge') {
    if (field.name === 'node') {
      const node = parent.node as AnyObj;
      return node ? sub(node, field.selectionSet) : null;
    }
    if (field.name === 'cursor') return parent.cursor as string;
    return unknown();
  }

  return unknown();
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(store: Store, origin: string, body: unknown): GraphQLResult | GraphQLResult[] {
  const ctx: Ctx = { store, origin };
  const runOne = (doc: Record<string, unknown>): GraphQLResult => {
    const query = doc.query as string | undefined;
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    const operationName = doc.operationName as string | undefined;
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: `parse error: ${(e as Error).message}` }] };
    }
    let operation: OperationNode | undefined;
    if (operations.length === 1) operation = operations[0];
    else if (operationName) operation = operations.find((o) => o.name === operationName);
    if (!operation) return { data: null, errors: [{ message: 'operation not found' }] };
    const vars: Record<string, unknown> = { ...variables };
    for (const v of operation.variables) {
      if (!(v.name in vars) && v.defaultValue) vars[v.name] = resolveValue(v.defaultValue, vars);
    }
    const errors: { message: string }[] = [];
    const root: AnyObj = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
    const data = resolveSelection(root.__typename, root, operation.selectionSet, vars, ctx, errors);
    const result: GraphQLResult = { data };
    if (errors.length > 0) result.errors = errors;
    return result;
  };
  if (Array.isArray(body)) return body.map((item) => runOne((item ?? {}) as Record<string, unknown>));
  return runOne((body ?? {}) as Record<string, unknown>);
}

export { ZERO_OID };
