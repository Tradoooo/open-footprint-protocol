# Open Footprint Protocol

**Coding agents should declare their footprint before they write.**

The Open Footprint Protocol (OFP) is a small, open HTTP contract that lets any coding agent —
and the client that drives it — announce *which files it is about to touch*, and get back a
verdict: go ahead, read the neighbour first, or stay out of this zone. It ships as three things:

1. **A protocol** — [PROTOCOL.md](PROTOCOL.md): five routes, one JSON body each, RFC-style rules.
2. **A skill** — [skill/SKILL.md](skill/SKILL.md): drop-in instructions for any agent
   (`avoid-collisions`), backend-agnostic.
3. **Schemas + a reference server** — [schemas/](schemas/) (JSON Schema draft-07, one file per
   message) and [examples/reference-server.mjs](examples/reference-server.mjs) (Node ≥ 18,
   zero dependencies, under 200 lines, with a `--selftest` mode).

Any backend can implement it — a Jira/Forge app, a GitHub App, a self-hosted service, or the
200-line in-memory server in `examples/`. Any agent client can emit it — Claude Code hooks,
a filesystem watcher, a CI step, or an agent following the skill by hand.

## Why

Worktrees isolate files, **not intentions**.

Four agents can work on four branches of the same repository and still collide: they rename the
same function, they both add a migration, they edit the same generated lockfile. Git finds out at
merge time — after the work is done, when the intent behind each change is already lost.

A *footprint* is the set of paths a piece of work touches. Footprints come from four sources,
each covering the others' blind spots:

| Source | Where it comes from | Worth |
|---|---|---|
| `predicted` | ticket metadata, similar merged tickets | a probability — never blocking |
| `declared` | the agent (or its pilot) says so before starting | an intention |
| `observed` | the client hook, on every file the agent is about to edit | a fact, without the agent's cooperation |
| `attested` | CI sends the changed-file list of a branch at push time | a fact, valid for humans too |

When two footprints overlap, the server computes a **collision degree** (D0–D5) and answers with a
**verdict** (`free` / `caution` / `wait` / `stop`) that names the neighbour, cites the path, and
says what to do instead. The protocol is **fail-open by design**: it advises, it does not block —
only an explicit, project-configured *hard mode* may deny an edit. And it is **sanitized by
design**: the server reads paths, sessions and working directories — never file content.

## Status — v1

- **Protocol version:** v1 (path-prefixed, additive evolution only — see PROTOCOL.md §9).
- **Reference implementation:** [Chantiers en collision](https://github.com/BaptisteFaisy/chantiers-en-collision),
  a Forge app for Jira/Bitbucket where the protocol was born (its `ingest` web trigger is the
  original server; its `avoid-collisions` skill is the original client).
- **Conformance:** the wire format defined here is exactly what the reference implementation
  sends and accepts. Known deviations and generalizations are listed in PROTOCOL.md §10.

## Repository layout

```
.
├── README.md                     ← this file
├── PROTOCOL.md                   ← the normative specification (v1)
├── LICENSE                       ← MIT
├── CONTRIBUTING.md               ← how to evolve the protocol
├── CODE_OF_CONDUCT.md
├── schemas/                      ← JSON Schema draft-07, one file per message
│   ├── open-request.json         ← POST …/v1/open
│   ├── touch-request.json        ← POST …/v1/touch
│   ├── close-request.json        ← POST …/v1/close
│   ├── ci-footprint-request.json ← POST …/v1/ci/footprint
│   ├── ci-conflict-request.json  ← POST …/v1/ci/conflict
│   ├── hook-response.json        ← the hook answer envelope (all hook routes)
│   └── verdict.json              ← the machine-readable verdict
├── skill/
│   └── SKILL.md                  ← the agent-facing skill (avoid-collisions)
└── examples/
    ├── curl.md                   ← every route in curl, + client integration examples
    └── reference-server.mjs      ← minimal runnable server (proof it fits in an evening)
```

## Adopting the protocol

### Server side

Implement the five routes under one installation base URL (`https://<INSTALLATION>/v1`):

| Route | Purpose | Answer |
|---|---|---|
| `POST /open` | a session starts (branch known) | hook response (context injection) |
| `POST /touch` | a file is about to be edited | hook response (verdict / deny) |
| `POST /close` | a session ends | empty 200 |
| `POST /ci/footprint` | attested footprint of a branch | `{ok, entries, worksiteId, issueKey}` |
| `POST /ci/conflict` | a real merge/rebase conflict happened | `{ok, conflictId, wasDetected}` |

The minimum you MUST provide (full list in PROTOCOL.md §10):

1. **Bearer auth** with server-stored sha256 hashes (tokens shown once); two scopes:
   *personal* (all routes) and *project* (`/ci/*` only).
2. **Sanitization**: read only the whitelisted fields; drop everything else — including any file
   content that may ride along in the client event — before processing *and* before storage.
3. **Fail-open**: every hook route answers HTTP 200 on any error, unknown route or unknown token.
   Only `/ci/*` may answer 401/400.
4. **A verdict** for `/touch` with at least: same file declared by two live sessions → D2
   `caution`, with neighbour named, path cited, advice given.

Fastest path to a working server:

```bash
node examples/reference-server.mjs --selftest   # starts, curls itself, prints SELFTEST OK
OFP_PORT=8787 node examples/reference-server.mjs
```

Then read [examples/curl.md](examples/curl.md) and [PROTOCOL.md](PROTOCOL.md).

### Client side

Two integration levels, combinable:

- **Hooks (observed footprint, no agent cooperation needed).** Point your agent client's
  session-start / pre-edit / session-end hooks at `/open`, `/touch`, `/close` with
  `Authorization: Bearer <personal token>`. Timeout ≤ 3 s; ignore any non-2xx or timeout and
  keep working. A ready-made Claude Code `settings.json` is in [examples/curl.md](examples/curl.md);
  any client works the same way (a 20-line filesystem watcher example is there too).
- **Skill (declared footprint, the agent cooperates).** Give your agent
  [skill/SKILL.md](skill/SKILL.md). It declares before writing, reads verdicts, redeclares on
  drift, posts notices before renames/deletions, and closes at the end — over MCP tools if the
  backend exposes them, or over raw HTTP against the five routes otherwise.

CI adds the attested source: one step that posts the branch's changed files to `/ci/footprint`,
and one that reports real conflicts to `/ci/conflict` (project token).

## License

MIT — see [LICENSE](LICENSE). The protocol, the schemas and the skill are free to implement,
embed and redistribute.
