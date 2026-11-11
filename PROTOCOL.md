# Open Footprint Protocol — v1

Status: **stable, version 1**. Keywords MUST/MUST NOT/SHOULD/MAY are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

This document is the normative specification. Message bodies are defined by the JSON Schemas in
[`schemas/`](schemas/) (draft-07); the schemas are authoritative for field names and types, this
document for behaviour. The reference implementation is
[Chantiers en collision](https://github.com/BaptisteFaisy/chantiers-en-collision)
(`src/glue/webtrigger.ts`); §10 lists every known deviation.

---

## 1. Terminology

- **Worksite** — the work in progress of one actor (a human or one agent session), optionally
  tied to one ticket, in one repository. One agent session = one worksite. A worksite has a
  state: `planned`, `open`, `active`, `paused`, `review`, `dormant`, `closed`.
- **Footprint** — the set of paths a worksite touches. A path is a file, a directory (covers
  everything inside) or a pattern. Paths are stored normalized, relative to the repository root,
  without leading `./` or `/`. Every footprint entry carries its **source**:
  - `predicted` — computed from ticket metadata and history; a probability, never blocking;
  - `declared` — announced by the agent or its pilot before the work; an intention;
  - `observed` — captured by a client hook on each file about to be edited; a fact, obtained
    without the agent's cooperation;
  - `attested` — the changed-file list of a branch, sent by CI at push time; a fact, valid for
    humans too.

  Fact beats intention: when an agent edits a path outside its declaration, the footprint widens,
  detection reruns, and the gap is noted on the entry (`declaredMismatch`).
- **Collision** — an overlap between the footprints of two live worksites, measured by a
  **degree** D0–D5:

  | Degree | Situation | Typical verdict |
  |---|---|---|
  | D0 | same named zone, different files | `free` (neighbour mentioned) |
  | D1 | same folder | `caution` |
  | D2 | same file | `caution` — read the neighbour worksite before editing |
  | D3 | same file, and one side deletes / moves / renames it | `wait` or coordinate |
  | D4 | exclusive resource, reserved zone or frozen zone | `wait`; `stop` in hard mode |
  | D5 | broken contract with no common file (interface change) | coordinate |

  Modulations a server MAY apply and SHOULD expose (`rawDegree` vs `degree`): hotspot zone −1;
  dormant neighbour −1; prediction-only side capped at D1 and tagged `probable`. Two worksites
  driven by the same pilot get **no discount** — tagged `samePilot`.
- **Verdict** — the answer to a declaration or a check: `kind` ∈ `free` | `caution` | `wait` |
  `stop`, plus one entry per collision. **No verdict without a named neighbour, a cited path, a
  reason and a course of action** (`neighbor`, `path`, `reason`, `advice` are REQUIRED in every
  collision entry).
- **Notice** — a short message posted by a worksite on a set of paths ("renaming
  `invoices.total` to `total_cents`"), delivered **once per recipient session** with the next
  verdict or injected hook context. This is the only way to reach an agent mid-work without
  interrupting its pilot.
- **Hard mode** — a per-project setting on reserved/frozen zones. Only hard mode allows a server
  to refuse an edit (`permissionDecision: "deny"`). Everywhere else the protocol advises.
- **Installation base URL** — the root under which a conforming server exposes the routes, e.g.
  `https://footprint.example.com/v1`. Denoted `<BASE>` below.

## 2. Transport

- All messages are **HTTPS POST** requests with a JSON body (`Content-Type: application/json`)
  to one of five route suffixes under `<BASE>`:

  | Route | Meaning | Schema | Answer |
  |---|---|---|---|
  | `POST <BASE>/open` | a session starts | `open-request.json` | hook response (§6) |
  | `POST <BASE>/touch` | a file is about to be edited | `touch-request.json` | hook response (§6) |
  | `POST <BASE>/close` | a session ends | `close-request.json` | empty 200 |
  | `POST <BASE>/ci/footprint` | attested footprint of a branch | `ci-footprint-request.json` | `{ok, entries, worksiteId?, issueKey?}` |
  | `POST <BASE>/ci/conflict` | a real conflict happened | `ci-conflict-request.json` | `{ok, conflictId, wasDetected}` |

- A server MAY mount the routes under any deeper prefix and MUST match them **by suffix**
  (`…/ingest/touch` routes to `touch`). Route matching is case-insensitive; `/ci/footprint` and
  `/ci/conflict` MUST be tested before `/open`, `/touch`, `/close`.
- The repository a hook route refers to comes from a request header, never from the event body:
  `X-Footprint-Repo: <owner>/<repo>`. A server MAY additionally accept a legacy alias (§10).
  When absent, the server SHOULD infer the repository from the token's project binding, or
  answer an empty 200 (fail-open, §5).
- Unknown fields in a request MUST be ignored (and discarded — see §4). A malformed JSON body
  MUST be treated as an empty body: fail-open, never 400 on hook routes.
- Timestamps are RFC 3339 / ISO 8601 strings, UTC recommended.

## 3. Authentication

- Every request carries `Authorization: Bearer <token>`. Header lookup MUST be case-insensitive.
- Two token scopes:
  - **personal** — identifies a human pilot and the agent sessions they drive; allowed on all
    five routes;
  - **project** — identifies a CI pipeline; allowed on `/ci/footprint` and `/ci/conflict`
    **only**. A project token on a hook route MUST be ignored (empty 200, §5) — it cannot open,
    touch or close a session.
- The server MUST store only a **sha256 hash** of each token; the clear value is shown to its
  owner **once**, at creation. Token verification MUST be constant-effort per request (hash and
  lookup).
- **Identity comes from the verified token, never from the body.** `session_id` and `agent_id`
  fields distinguish the sessions *of the authenticated pilot*; they grant no right and cannot be
  used to act as someone else. There is no anonymous worksite: a server MUST attach every
  worksite to the token's account.
- Invalid or missing token:
  - on hook routes (`/open`, `/touch`, `/close`): the server MUST answer **HTTP 200 with an empty
    body** (the agent keeps working; a broken token must never break a session);
  - on `/ci/*`: the server MUST answer **HTTP 401** with body `{"error":"unauthorized"}` — the
    caller is a pipeline, and a silent 200 would hide a broken step.

## 4. Sanitization (MUST)

Client hook events can carry file content (a pre-edit event typically contains the old and new
text). **The server reads paths, never content.**

- On `/touch`, the server MUST read — and MUST read **only** — these fields of the request body:
  `session_id`, `tool_input.file_path`, `cwd`, `agent_id`, `agent_type`, `hook_event_name`.
- On `/open`: `session_id` (or `sessionRef`), `branch`, `cwd`, `agent_id` (or `agentRef`),
  optionally `issueKey`. On `/close`: `session_id` (or `sessionRef`), `reason`.
- Everything else — `tool_input.old_string`, `tool_input.new_string`, any file content, any
  prompt text — MUST be dropped **before any processing, any service call and any storage**.
  A conforming backend stores paths, sessions, branches and timestamps; it MUST NOT persist raw
  event bodies.
- Missing required fields after sanitization (`session_id` or `tool_input.file_path` on `/touch`;
  `branch` on `/open`) → empty 200 on hook routes; missing required fields on `/ci/*` → 400 with
  `{"error":"<what is missing>"}`.
- Absolute paths SHOULD be converted to repository-relative using `cwd`. Clients that must not
  let content leave the machine MAY pre-sanitize (a local script that forwards only the path is
  conforming: the server cannot read what it never receives).

## 5. Fail-open

The protocol advises; it does not block.

- **Client side:** the hook call MUST have a timeout of **≤ 3 seconds** (1.5 s recommended for
  session-end events, whose budget is smaller). On timeout, on transport error, or on any non-2xx
  response, the client MUST ignore the answer and **the work continues**. Clients SHOULD NOT
  retry within the same event.
- **Server side:** hook routes MUST answer HTTP 200 on *any* internal error, unknown route,
  unknown token or malformed body — an empty body is always a valid answer ("nothing to say,
  carry on"). The server MUST NOT answer 4xx/5xx on hook routes (401 is reserved to `/ci/*`,
  400 to malformed `/ci/*` bodies).
- **The single exception** is hard mode: when the project enabled it for the zone concerned, a
  `/touch` MAY answer `permissionDecision: "deny"` (§6). Denial is a deliberate, visible,
  project-configured decision — never an accident of transport.

## 6. Hook response semantics

Hook routes (`/open`, `/touch`) answer with either an **empty 200 body** (nothing to inject) or
a JSON envelope — schema `hook-response.json`:

```jsonc
// Inform: inject context into the agent (work continues).
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",          // echoes the event: SessionStart | PreToolUse | SessionEnd | SubagentStart
    "additionalContext": "Neighbour worksite: PROJ-88 (agent of Léa, PR open) is also editing src/billing/invoice.ts. Notice: \"renaming invoices.total to total_cents\". Read their PR before editing this file."
  }
}
```

```jsonc
// Hard mode only: refuse the edit, with the reason.
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "db/migrations/ is reserved by PROJ-88 until 15:10. Keep working outside this folder, then redeclare."
  }
}
```

- `additionalContext` SHOULD embed the human-readable rendering of the verdict (kind, degree,
  neighbour, path, reason, advice, pending notices). The machine-readable verdict
  (`verdict.json`) MAY be exposed through richer transports (MCP tools, APIs) and SHOULD be
  embedded as JSON when the client supports it.
- `permissionDecision: "deny"` MUST only be emitted for zones under hard mode. A deny MUST carry
  a `permissionDecisionReason` that names the neighbour and says what to do instead.
- `/close` answers an empty 200; its response is not used (small event budget).

## 7. Lifecycle

`open → touch* → close`, with bounded everything.

- **Open.** A session start (or a declaration) opens a worksite. The branch is REQUIRED; the
  server SHOULD read the ticket key from the branch name when the body carries none. A branch
  with no ticket key still opens a worksite, attached to the pilot and the branch.
- **Touch.** Each pre-edit event adds the path to the worksite's *observed* footprint and
  returns the current verdict. Touches keep the worksite `active`.
- **Close.** A session end pauses or closes the worksite (`reason` MAY carry an outcome such as
  `merged`, `abandoned`, `done`). Closing releases everyone waiting on it.
- **Dormancy.** A worksite with no activity for the dormancy delay (default 24 h, configurable)
  goes `dormant` (its collisions drop one degree) and eventually closes itself (default 7 days
  dormant). **No ghost worksite:** a client that never sends `/close` MUST NOT be able to block
  neighbours forever.
- **Nothing is eternal.** Reservations are bounded in duration (default 2 h, maximum 24 h,
  extendable only by observed activity) and in extent (beyond a path threshold, a reservation
  becomes a freeze *request* requiring a responsible human). An idle worksite sleeps, then
  closes.
- **Concurrency.** Two declarations landing at the same instant MUST each see the other (both
  get `caution`); there is no silent winner.

## 8. Notices

- A worksite MAY post a notice on a set of paths before a rename, a deletion, a move or a
  signature change. Notices are short, factual text.
- Delivery: **once per recipient session**, piggybacked on the next verdict (`pendingNotices`)
  or the next injected hook context — a server MUST NOT deliver the same notice twice to the
  same session, and MUST send one alert per collision, not per file.
- Notices remain visible on the worksite/ticket after delivery.

## 9. Versioning

- The version is carried by the path prefix: `<BASE>` ends with `/v1`. A server MAY also expose
  the version in a response header (`X-Footprint-Version: v1`); the path is authoritative.
- **v1 evolves additively only.** New optional fields, new optional routes, new enum values in
  *server-rendered* text are allowed without a version bump; every participant MUST ignore
  unknown fields and unknown routes (with an empty 200 on hook routes).
- Anything that breaks a conforming v1 client — removing or renaming a field, tightening a
  required constraint, changing fail-open behaviour — requires **v2**, served side by side with
  v1 for a deprecation period of at least one year.
- Extensions (extra routes, extra verdict metadata) SHOULD live under a vendor prefix
  (`x-` fields or `/<vendor>/…` routes) so that v1 stays interoperable. See CONTRIBUTING.md.

## 10. Conformance

### 10.1 Minimum server

A conforming v1 server MUST:

1. expose the five routes under one base URL, matched by suffix (§2);
2. authenticate with `Bearer` tokens stored as sha256 hashes, with `personal` and `project`
   scopes and the scope/route matrix of §3; 401 only on `/ci/*`;
3. sanitize every hook body to the whitelist of §4 and store no file content, ever;
4. fail open: HTTP 200 empty body on any error on hook routes (§5);
5. maintain worksite state (`open → touch* → close`) with dormancy and expiration (§7);
6. on `/touch`, compute at least the D2 rule — *the same file in the live footprints of two
   different sessions* → verdict `caution` with a collision entry naming the neighbour
   (`issueKey`, `actorLabel`, `state`), the `path`, a `reason` and an `advice` — and return it
   as `additionalContext` (or a deny under hard mode);
7. accept attested footprints on `/ci/footprint` and real conflicts on `/ci/conflict`, and
   record whether each reported conflict had been detected (`wasDetected`);
8. deliver each notice at most once per session (§8).

Degrees D0/D1/D3/D5, zones, predictions, hard mode, reservations and the richer verdict fields
(`collisionId`, `zoneNature`, `estimatedResumeMinutes`, `freezeSuggestion`…) are OPTIONAL in v1
— a server implementing only the minimum is conforming and interoperable.

### 10.2 Minimum client

A conforming v1 client MUST:

1. send `/open` at session start (with `session_id` and `branch`), `/touch` before each file
   edit (with `session_id` and `tool_input.file_path`), `/close` at session end;
2. carry a personal token in `Authorization: Bearer`, and the repository in `X-Footprint-Repo`;
3. time out at ≤ 3 s and ignore timeouts and non-2xx answers — the work continues (§5);
4. surface `additionalContext` to the agent, and honour `permissionDecision: "deny"` by not
   performing the edit;
5. never fabricate another pilot's identity: `session_id`/`agent_id` only distinguish the
   token owner's own sessions (§3).

Emitting `/ci/*` from pipelines (project token) is RECOMMENDED, not required.

### 10.3 Known deviations from the reference implementation

The reference implementation predates this document; the differences are recorded here so both
sides can converge:

- **Repository header.** This spec names it `X-Footprint-Repo`; the reference reads
  `X-Chantier-Repo`. A conforming server SHOULD accept both; the reference server in
  `examples/` does.
- **Route prefix.** The reference matches suffixes under a Forge `urlFormat: v2` path
  (`…/v2/<appId>/ingest/<route>`); this spec fixes the version prefix to `/v1`. Suffix matching
  makes the two compatible.
- **Verdict body.** The reference injects the verdict as rendered text in `additionalContext`
  (its MCP layer exposes the machine-readable `verdict.json` shape). This spec keeps that
  wire behaviour for hooks and publishes the JSON shape for richer transports.
- **`issueKey` on `/open`.** The reference reads it when present but prefers deriving it from
  the branch; this spec keeps `issueKey` optional with the same precedence guidance.
