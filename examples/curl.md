# Every route in curl

Base URL of a conforming installation: `https://<INSTALLATION>/v1`. Tokens:

```bash
export OFP_BASE="https://<INSTALLATION>/v1"
export OFP_TOKEN="<personal token>"     # shown once at creation; the server keeps only its sha256
export OFP_CI_TOKEN="<project token>"   # CI scope: /ci/* routes ONLY
```

Reminder (PROTOCOL.md §5): hook routes are **fail-open** — keep a `--max-time 3` on every call
and ignore any non-2xx or timeout. Only `/ci/*` answers 401 (bad token) or 400 (bad body).

## 1. `POST /open` — a session starts

```bash
curl -sS --max-time 3 -X POST "$OFP_BASE/open" \
  -H "Authorization: Bearer $OFP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Footprint-Repo: acme/billing" \
  -d '{
    "session_id": "sess-9f3c",
    "branch": "feature/PROJ-101-invoice-total",
    "cwd": "/home/dev/billing",
    "agent_id": "sub-2",
    "agent_type": "claude-code",
    "hook_event_name": "SessionStart"
  }'
```

Expected — empty 200 when there is nothing to inject, or context listing the neighbours:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Neighbour worksites on acme/billing: PROJ-88 (agent of Léa, PR open) declared src/billing/invoice.ts, db/migrations/. Notice from PROJ-88: \"renaming invoices.total to total_cents\"."
  }
}
```

`issueKey` is optional: the server reads it from the branch (`PROJ-101`) when the body has none.

## 2. `POST /touch` — before each file edit

The raw client event. **The server reads only `session_id`, `tool_input.file_path`, `cwd`,
`agent_id`, `agent_type`, `hook_event_name`** — everything else (here `old_string`,
`new_string`: file content) is dropped before any processing or storage.

```bash
curl -sS --max-time 3 -X POST "$OFP_BASE/touch" \
  -H "Authorization: Bearer $OFP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Footprint-Repo: acme/billing" \
  -d '{
    "session_id": "sess-9f3c",
    "hook_event_name": "PreToolUse",
    "cwd": "/home/dev/billing",
    "tool_input": {
      "file_path": "/home/dev/billing/src/billing/invoice.ts",
      "old_string": "total: number",
      "new_string": "totalCents: number"
    }
  }'
```

Expected — empty 200 when the path is free; otherwise a verdict as context:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "verdict: caution\ncollision: D2 · ordinary\nneighbor: PROJ-88 · agent of Léa (session 3f2a) · PR open · active 4 min ago\nreason: same file touched by two worksites\nneighbor's notice: \"renaming invoices.total to total_cents\"\nwhat to do: read the neighbor worksite before editing this file"
  }
}
```

…or, in hard mode only (reserved/frozen zone), a deny:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "db/migrations/ is reserved by PROJ-88 until 15:10. Keep working outside this folder, then redeclare."
  }
}
```

Bad token here → **empty 200** (a broken token must never break a session).

## 3. `POST /close` — session end

```bash
curl -sS --max-time 2 -X POST "$OFP_BASE/close" \
  -H "Authorization: Bearer $OFP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Footprint-Repo: acme/billing" \
  -d '{ "session_id": "sess-9f3c", "reason": "done" }'
```

Expected: empty 200, always. The response is not used (small event budget); dormancy covers
clients that never send this.

## 4. `POST /ci/footprint` — attested footprint of a branch (project token)

```bash
# files changed since the divergence point with the base branch
FILES=$(git diff --name-only "origin/${BASE_BRANCH:-main}...HEAD")

curl -sS -X POST "$OFP_BASE/ci/footprint" \
  -H "Authorization: Bearer $OFP_CI_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg files "$FILES" '{
    repoSlug: "acme/billing",
    branch: "feature/PROJ-101-invoice-total",
    baseBranch: "main",
    issueKey: "PROJ-101",
    paths: $files,
    prOpen: true,
    prApproved: false
  }')"
```

Expected:

```jsonc
{ "ok": true, "entries": 7, "worksiteId": "ws_01HXX…", "issueKey": "PROJ-101" }
```

Missing `repoSlug`/`branch`/files → `400 {"error":"repoSlug, branch and files are required"}`.
Invalid token → `401 {"error":"unauthorized"}`. A personal token also works on this route.

## 5. `POST /ci/conflict` — a real conflict happened (project token)

Sent when a rebase/merge actually conflicted, so the backend records whether it saw it coming:

```bash
curl -sS -X POST "$OFP_BASE/ci/conflict" \
  -H "Authorization: Bearer $OFP_CI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "issueKey": "PROJ-101",
    "repoSlug": "acme/billing",
    "paths": ["src/billing/invoice.ts", "src/shared/money.ts"],
    "withIssueKey": "PROJ-88"
  }'
```

Expected:

```jsonc
{ "ok": true, "conflictId": "col_01HXX…", "wasDetected": true }
```

`wasDetected: false` means the protocol missed it — backends use this to measure their own misses.

## Claude Code integration (`settings.json`, http hook)

Drop-in client for the `/touch` route (SessionStart/SessionEnd can use a local script that reads
the branch and posts `/open` and `/close`). Timeout 3 s: on timeout or error, Claude Code
continues — fail-open, exactly as the protocol requires.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "http",
            "url": "https://<INSTALLATION>/v1/touch",
            "timeout": 3,
            "headers": {
              "Authorization": "Bearer $FOOTPRINT_TOKEN",
              "X-Footprint-Repo": "acme/billing"
            },
            "allowedEnvVars": ["FOOTPRINT_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

Teams that must not let any content leave the machine can replace the `http` hook with a local
script that forwards **only the path** — the server cannot read what it never receives.

## Generic filesystem watcher (any client, ~20 lines)

For agent clients without hooks: watch the worktree, and on each created/modified file post a
`/touch`. One declaration per file, first write wins, 3 s timeout, errors ignored.

```js
// watcher.mjs — node watcher.mjs <worktree> ; env: OFP_BASE, OFP_TOKEN, OFP_REPO, OFP_SESSION
import { watch } from "node:fs";
const [root] = process.argv.slice(2);
const seen = new Set();
const post = (path) =>
  fetch(`${process.env.OFP_BASE}/touch`, {
    method: "POST",
    signal: AbortSignal.timeout(3000),               // fail-open: ≤ 3 s, then move on
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OFP_TOKEN}`,
      "x-footprint-repo": process.env.OFP_REPO,
    },
    body: JSON.stringify({                            // sanitized at the source: path only
      session_id: process.env.OFP_SESSION, cwd: root,
      hook_event_name: "PreToolUse", tool_input: { file_path: path },
    }),
  })
    .then(async (r) => (r.ok ? r.text() : ""))
    .then((t) => t && console.log("[footprint]", t))
    .catch(() => {});                                 // network down → work continues
for await (const { filename } of watch(root, { recursive: true })) {
  const rel = filename.replaceAll("\\", "/");
  if (rel.includes("/.git/") || seen.has(rel)) continue;
  seen.add(rel);
  post(rel);
}
```
