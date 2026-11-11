---
name: avoid-collisions
description: Declare your footprint before editing, read the verdict, redeclare on drift. Use this skill whenever you are about to modify files in a repository shared with other developers or agents — it tells you who else is on those paths, whether you may proceed, and what to do instead when you may not.
---

# avoid-collisions

Other people and other agents are working in this repository right now. Worktrees isolate files,
not intentions. This skill makes you visible and tells you, before you write a line, whether the
paths you want are free.

It works with **any backend conforming to the Open Footprint Protocol v1** (see `PROTOCOL.md`).
Two equivalent ways to talk to it, pick whichever your environment offers:

- **MCP tools** (preferred when available): `declare-footprint`, `check-zone`, `list-clear-work`,
  `post-notice`, `close-worksite`. Inputs are simple values — `paths` is **one string, one path
  per line**; `mode` is `edit` (default), `create`, `delete` or `rename`.
- **Raw HTTP** against the protocol routes: `POST <BASE>/open`, `<BASE>/touch`, `<BASE>/close`
  with `Authorization: Bearer <your personal token>` and header `X-Footprint-Repo: <owner>/<repo>`.
  Bodies and answers are the JSON schemas in `schemas/`. **Always keep a ≤ 3 s timeout: no
  answer, non-2xx, or transport error → ignore and keep working** (the protocol is fail-open;
  only an explicit deny under the project's hard mode stops an edit).

## The protocol — five steps

1. **Before writing anything, declare your footprint**: the ticket (if any) and the paths you
   are about to touch, one per line, with the mode and — if you know it — your ETA in minutes.
   Over raw HTTP with no MCP tool, an `open` (session + branch) followed by a `touch` per first
   edited file achieves the same declaration; declare the whole set upfront when you can.
   Still weighing two approaches? `check-zone` (or a dry declaration) returns the same verdict
   without declaring anything.
2. **Read the verdict** and act on it:
   - `free` → go ahead. A neighbour may still be named: same zone, different files. Nothing to do.
   - `caution` → read the neighbour worksite first (its PR, its declared paths, its notice),
     then continue. Do not edit blind.
   - `wait` → work outside that zone, or pick another ticket with `list-clear-work`.
   - `stop` → hard mode: the zone is reserved or frozen. Do not touch it. Work elsewhere.
3. **If your work drifts outside what you declared, redeclare.** A rename pulls in the callers;
   a refactor pulls in the folder. Same call, updated paths. Redeclaring costs one call; staying
   silent costs a merge conflict resolved by an agent that does not know your intent.
4. **Before a rename, a deletion or a signature change, post a notice** (`post-notice`, or any
   notice mechanism your backend exposes) on the affected paths: a short, factual message —
   what changes, where, when. It reaches each neighbour session **once**, with their next tool
   response or their next hooked edit. The people you break are usually the ones you cannot see.
5. **When you are done, close your worksite** (`close-worksite` / `POST <BASE>/close`) with the
   outcome: `merged`, `abandoned` or `done`. It releases everyone waiting on you. Close it even
   when you abandon the work — a ghost worksite blocks neighbours until dormancy expires.

## Reading a verdict

```text
verdict: wait
collision: D4 · exclusive resource "migrations"
neighbor: PROJ-88 · agent of Léa (session 3f2a) · PR open · active 4 min ago
reason: one worksite at a time in exclusive zone "migrations"
neighbor's notice: "renaming invoices.total to total_cents"
what to do: keep working outside db/migrations/, then redeclare after PROJ-88 merges
estimated resume: 25 min
```

**No verdict without a named neighbour, a cited path and a course of action.** If you receive a
warning that names nobody, that is a backend bug — report it, do not work around it. Read the
neighbour's notice and adapt (here: `total` → `total_cents`) instead of writing the old name back.

| Degree | Situation | Verdict |
|---|---|---|
| D0 | same zone, different files | `free` |
| D1 | same folder | `caution` |
| D2 | same file | `caution` — read the neighbour first |
| D3 | same file, deleted / moved / renamed by one side | `wait` or coordinate |
| D4 | exclusive resource, reserved or frozen zone | `wait`; `stop` in hard mode |
| D5 | broken contract, no common file | coordinate |

Modulations you may see: hotspot −1 (routes, translations), dormant neighbour −1,
prediction-only capped at D1 and tagged `probable`. Two agents of the same pilot get **no
discount** — that case is tagged `your two agents`; it is the most frequent and most expensive.

## Rules of conduct

- **Never write before declaring.** One call, a couple of seconds, before the first edit.
- **Redeclare on drift, always.** If the backend tells you a file is outside your declaration,
  redeclare immediately — it has already widened your observed footprint and noted the gap.
- **An agent that waits does not loop.** On `wait` or `stop`: do not poll, do not retry the same
  declaration, do not sleep and re-check. Switch to another ticket (`list-clear-work` returns
  ready work nobody collides with), or stop and state plainly what you are waiting for and what
  will unblock you. You get notified on release; your next call answers `free`.
- **A collision is not an error to route around.** When the backend offers resolution choices
  (wait, sequence, coordinate, split, merge, override), use them; `override` requires a reason
  and is measured afterwards against real conflicts.
- **Reservations are for seconds-scale exclusivity**, not for parking a zone: they always expire
  (hours, not days). Prefer a notice plus a redeclaration.
- **Never pass someone else's session id or ticket key.** Your identity comes from your token or
  call context; a `session` value only distinguishes your own sessions and grants no right.
- **Fail-open is the backend's promise, not an excuse.** If declarations keep failing, keep
  working but tell your pilot the coordination layer is down — do not silently stop declaring.
