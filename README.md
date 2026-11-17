[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/oreo-sol/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/oreo-sol/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# forge — a GitHub-compatible git forge

A real, runnable git forge for the [make.fun github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty. One Node process, standard library only, no dependencies, no git binary, no outside service. Everything is in-memory and deterministic (a logical clock supplies timestamps; two runs on the same instance leave the same state export byte for byte).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack v2 (`fetch` with `shallow`, `ls-refs` with `unborn`/`peel`/`symrefs`/`ref-prefix`) and v0, receive-pack v0 with `report-status` (`unpack ok`, per-ref `ok`/`ng … non-fast-forward`, `delete-refs`). Packfiles are read and written with OFS/REF delta support; fetch honours haves, depth limits, shallow/unshallow boundaries.
- **REST v3** under `/api/v3` — repos, refs, branches, commits, trees, contents (create/update/delete with 201/200/409 semantics), labels, issues (with comments), pull requests (with files, squash/merge, real three-way merge and 405 on conflict), plus the protocol rules: JSON everywhere, `X-GitHub-Request-Id` on every reply, `X-OAuth-Scopes` on the root.
- **GraphQL** at `/api/graphql` — viewer, repository, issue, pullRequests, mutations (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`), `node(id:)` with global ids, `__type` introspection, cursor pagination, batched operations.
- **MCP** at `/mcp` — Streamable HTTP, JSON-RPC 2.0, `server/discover` (2026-07-28) and the legacy `initialize` handshake, six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **`GET /healthz`** → `200 {"ok":true}` (no auth). Every other call needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.

## Layout

- `main.ts` — the entry ↔ env lifecycle (starter, unchanged): bind an ephemeral port, register it, wait for done.
- `app.ts` — the HTTP server: routing, auth, JSON plumbing.
- `forge/store.ts` — the in-memory data model (repos, refs, objects, issues, PRs, labels, comments; logical clock).
- `forge/git.ts` — git primitives: pkt-line, pack read/write with deltas, trees, commits, merge-base, three-way merge, line diff, fetch computation.
- `forge/githttp.ts` — smart-HTTP handlers (advertisements, upload-pack, receive-pack) and a fetch pack cache.
- `forge/rest.ts` — the REST v3 handlers.
- `forge/graphql.ts` — a small GraphQL parser + executor for the operations the suite uses.
- `forge/mcp.ts` — the MCP handler and the six tools.
- `forge/scenario.ts` — the scenario's seeded PRNG (vendored from the kit) that computes the token owner's login at startup instead of hardcoding it.

## Verified locally

Against the kit's own conformance runner (`sdk/run.ts`) and a full local trial run of the sealed env (`program/env/server.mjs`):

- **Conformance: 120/120** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- **Perf: 145–149/200** (push ~36–40, clone ~34–35, read ~37–39, write ~33–38) — the reference forge scores 100 at its calibration medians, so the total is ~945/1000.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Node 22+ (type stripping on by default). No install step, no build step.

## Try it

```sh
# health
curl http://127.0.0.1:PORT/healthz
# create a repo and push to it with any git client
curl -X POST http://127.0.0.1:PORT/api/v3/user/repos \
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"name":"hello"}'
git clone http://127.0.0.1:PORT/adaiversen/hello.git
```
