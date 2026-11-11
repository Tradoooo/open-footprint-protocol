#!/usr/bin/env node
/**
 * Open Footprint Protocol v1 — minimal reference server. Node >= 18, zero deps, in-memory.
 * PROTOCOL.md §10.1 minimum: five routes by suffix, Bearer auth (sha256, personal/project),
 * sanitization, fail-open on hooks, D2 rule (same file in two live worksites → caution).
 * Optional-in-v1 features (hard mode, zones, D0/D1/D3-D5, dormancy, notices) are absent.
 * Run: node reference-server.mjs [--selftest] — port OFP_PORT=8787; tokens demo-personal, demo-project.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const TOKENS = new Map([
  [sha256("demo-personal"), { scope: "personal", accountId: "acc_demo" }],
  [sha256("demo-project"), { scope: "project", accountId: "acc_ci" }],
]);
const ROUTES = [["/ci/footprint", "ci-footprint"], ["/ci/conflict", "ci-conflict"],
  ["/open", "open"], ["/touch", "touch"], ["/close", "close"]];
const sessions = new Map(); // sessionRef -> worksite {branch, repo, issueKey, state, paths:Set}
let seq = 0;
const nextId = (p) => `${p}_${(++seq).toString(36).padStart(6, "0")}`;
const routeOf = (url) => {
  const p = url.split("?")[0].replace(/\/+$/, "").toLowerCase();
  return ROUTES.find(([s]) => p.endsWith(s))?.[1];
};
const bearerOf = (headers) => {
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const m = raw !== undefined && /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : undefined;
};
const rec = (v) => (typeof v === "object" && v !== null ? v : {});
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const lines = (v) => Array.isArray(v) ? v.map(text).filter(Boolean)
  : text(v)?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
const relPath = (raw, cwd) => { // sanitization: absolute → repo-relative via cwd
  let p = raw.trim();
  if (cwd && p.startsWith(cwd)) p = p.slice(cwd.length);
  return p.replace(/^\.?\//, "");
};
const live = (ws) => ws && ws.state !== "closed";
const repoOf = (headers) => { // spec header first, legacy alias accepted (§10.3)
  const hit = Object.entries(headers).find(([k]) => ["x-footprint-repo", "x-chantier-repo"].includes(k.toLowerCase()));
  return hit && text(String(hit[1]));
};
const ticketOf = (issueKey, branch) => text(issueKey) ?? branch?.match(/[A-Z]+-\d+/)?.[0];
/* -------- verdict: the only rule a minimum server MUST implement (D2, §10.1.6) -------- */
function verdictFor(sessionRef, path) {
  const collisions = [];
  for (const [ref, ws] of sessions) {
    if (ref === sessionRef || !live(ws) || !ws.paths.has(path)) continue;
    collisions.push({
      degree: 2, path,
      neighbor: { issueKey: ws.issueKey ?? ws.branch, actorLabel: `session ${ref}`, state: ws.state },
      reason: "same file touched by two worksites",
      advice: "read the neighbor worksite before editing this file",
    });
  }
  if (collisions.length === 0) return undefined; // free → empty 200
  const c = collisions[0];
  return { kind: "caution", collisions, text: `verdict: caution\ncollision: D2 · ordinary\nneighbor: ${c.neighbor.issueKey} · ${c.neighbor.actorLabel} · ${c.neighbor.state}\nreason: ${c.reason}\nwhat to do: ${c.advice}` };
}
/* --------------------------------- route handlers --------------------------------- */
function onOpen(body, repo) {
  const sessionRef = text(body.session_id) ?? text(body.sessionRef); // all else is dropped
  const branch = text(body.branch);
  if (!sessionRef || !branch) return null;
  const prev = sessions.get(sessionRef) ?? { paths: new Set(), id: nextId("ws") };
  sessions.set(sessionRef, { ...prev, branch, repo, issueKey: ticketOf(body.issueKey, branch), state: "open", at: new Date().toISOString() });
  const others = [...sessions].filter(([r, w]) => r !== sessionRef && live(w) && w.repo === repo && w.paths.size)
    .map(([r, w]) => `${w.issueKey ?? w.branch} (session ${r}): ${[...w.paths].join(", ")}`).join("\n");
  if (!others) return null;
  return { hookEventName: "SessionStart", additionalContext: `Neighbour worksites on ${repo ?? "this repo"}:\n${others}` };
}
function onTouch(body, repo) {
  // Sanitization: rebuild the event from the whitelist ONLY — tool_input.old_string,
  // new_string and any other field (file content) never reach state or storage (§4).
  const sessionRef = text(body.session_id);
  const filePath = text(rec(body.tool_input).file_path);
  if (!sessionRef || !filePath) return null;
  const path = relPath(filePath, text(body.cwd));
  const ws = sessions.get(sessionRef) ?? { paths: new Set(), branch: "unknown", id: nextId("ws") };
  sessions.set(sessionRef, ws);
  ws.repo = ws.repo ?? repo; ws.paths.add(path); ws.state = "active"; ws.at = new Date().toISOString();
  const verdict = verdictFor(sessionRef, path);
  if (!verdict) return null; // free → empty 200, work continues
  return { hookEventName: text(body.hook_event_name) ?? "PreToolUse", additionalContext: verdict.text };
}
function onClose(body) {
  const sessionRef = text(body.session_id) ?? text(body.sessionRef);
  const ws = sessionRef && sessions.get(sessionRef);
  if (ws) { ws.state = "closed"; ws.outcome = text(body.reason); }
  return undefined; // SessionEnd output is not used: always empty 200
}
function onCiFootprint(body) {
  const repoSlug = text(body.repoSlug) ?? text(body.repo);
  const branch = text(body.branch);
  const files = lines(body.files ?? body.paths);
  if (!repoSlug || !branch || files.length === 0)
    return { status: 400, json: { error: "repoSlug, branch and files are required" } };
  const ref = `ci:${repoSlug}:${branch}`;
  const prev = sessions.get(ref) ?? { paths: new Set(), id: nextId("ws") };
  const ws = { ...prev, repo: repoSlug, branch, issueKey: ticketOf(body.issueKey, branch), state: body.prOpen ? "review" : "paused", at: new Date().toISOString() };
  sessions.set(ref, ws);
  for (const f of files) ws.paths.add(relPath(f)); // attested source
  return { status: 200, json: { ok: true, entries: files.length, worksiteId: ws.id, issueKey: ws.issueKey } };
}
function onCiConflict(body) {
  const issueKey = text(body.issueKey);
  const repoSlug = text(body.repoSlug) ?? text(body.repo);
  const paths = lines(body.paths);
  if (!issueKey || !repoSlug || paths.length === 0)
    return { status: 400, json: { error: "issueKey, repoSlug and paths are required" } };
  // wasDetected: had we already seen a conflicted path in two distinct worksites?
  const holders = (p) => [...sessions.values()].filter((ws) => ws.paths.has(relPath(p))).length;
  const wasDetected = paths.some((p) => holders(p) >= 2);
  return { status: 200, json: { ok: true, conflictId: nextId("col"), wasDetected } };
}
/* --------------------------------------- server --------------------------------------- */
const empty200 = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(""); };
const send = (res, status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST") return empty200(res);
    const route = routeOf(req.url ?? "");
    if (!route) return empty200(res); // unknown route → fail open
    const token = bearerOf(req.headers);
    const verified = token && TOKENS.get(sha256(token));
    // Unknown token: silent 200 on hook routes (never break a session); 401 on /ci/*.
    if (!verified) return route.startsWith("ci") ? send(res, 401, { error: "unauthorized" }) : empty200(res);
    if (verified.scope === "project" && !route.startsWith("ci")) return empty200(res); // scope matrix (§3)
    const raw = await new Promise((ok) => { let d = ""; req.on("data", (c) => { if (d.length < 1e6) d += c; }); req.on("end", () => ok(d)); });
    let body = {}; try { body = rec(JSON.parse(raw)); } catch { body = {}; } // malformed body = empty body
    if (route === "ci-footprint") { const r = onCiFootprint(body); return send(res, r.status, r.json); }
    if (route === "ci-conflict") { const r = onCiConflict(body); return send(res, r.status, r.json); }
    if (route === "close") { onClose(body); return empty200(res); }
    const hook = route === "open" ? onOpen(body, repoOf(req.headers)) : onTouch(body, repoOf(req.headers));
    if (!hook) return empty200(res); // nothing to inject → carry on
    return send(res, 200, { hookSpecificOutput: hook });
  } catch {
    return empty200(res); // FAIL-OPEN, always
  }
});
/* --------------------------------------- selftest --------------------------------------- */
async function selftest(base) {
  const call = async (route, token, body, headers = {}) => { // client rule: ≤ 3 s, then move on
    const r = await fetch(`${base}${route}`, { method: "POST", signal: AbortSignal.timeout(3000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : undefined };
  };
  const hdr = { "x-footprint-repo": "acme/billing" }, f = "src/billing/invoice.ts";
  const check = (name, cond) => { if (!cond) throw new Error(`FAILED: ${name}`); console.log(`  ok  ${name}`); };
  const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
  let r = await call("/open", "demo-personal", { session_id: "sess-a", branch: "feature/PROJ-101-total", cwd: "/w" }, hdr);
  check("open A → 200", r.status === 200);
  r = await call("/touch", "demo-personal", { session_id: "sess-a", cwd: "/w", tool_input: { file_path: `/w/${f}`, old_string: "SECRET CONTENT", new_string: "MORE SECRET" } }, hdr);
  check("touch A first → free (empty 200)", r.status === 200 && r.json === undefined);
  r = await call("/open", "demo-personal", { session_id: "sess-b", branch: "feature/PROJ-88-refactor" }, hdr);
  check("open B sees neighbour A", ctx(r).includes("PROJ-101"));
  r = await call("/touch", "demo-personal", { session_id: "sess-b", tool_input: { file_path: f } }, hdr);
  check("touch B same file → D2 caution naming the neighbour", ctx(r).includes("D2") && ctx(r).includes("sess-a"));
  r = await call("/touch", "nope", { session_id: "sess-b", tool_input: { file_path: f } }, hdr);
  check("bad token on hook route → silent 200 (fail-open)", r.status === 200 && r.json === undefined);
  r = await call("/touch", "demo-project", { session_id: "sess-b", tool_input: { file_path: f } }, hdr);
  check("project token cannot touch → silent 200", r.status === 200 && r.json === undefined);
  r = await call("/ci/footprint", "demo-project", { repoSlug: "acme/billing", branch: "feature/PROJ-101-total", paths: "src/shared/money.ts\nsrc/billing/tax.ts", prOpen: true });
  check("ci footprint → ok + entries", r.json?.ok === true && r.json?.entries === 2);
  r = await call("/ci/footprint", "demo-project", { branch: "x" });
  check("ci footprint missing fields → 400", r.status === 400);
  r = await call("/ci/footprint", "bad", { repoSlug: "a/b", branch: "x", files: ["y"] });
  check("bad token on /ci → 401", r.status === 401 && r.json?.error === "unauthorized");
  r = await call("/ci/conflict", "demo-project", { issueKey: "PROJ-101", repoSlug: "acme/billing", paths: [f] });
  check("ci conflict → wasDetected true (seen on two worksites)", r.json?.ok === true && r.json?.wasDetected === true);
  r = await call("/close", "demo-personal", { session_id: "sess-b", reason: "abandoned" }, hdr);
  check("close B → 200", r.status === 200);
  r = await call("/touch", "demo-personal", { session_id: "sess-a", tool_input: { file_path: f } }, hdr);
  check("after close, A is free again", r.status === 200 && r.json === undefined);
  r = await call("/nonsense", "demo-personal", {}, hdr);
  check("unknown route → fail-open 200", r.status === 200);
}
const isSelftest = process.argv.includes("--selftest");
server.listen(isSelftest ? 0 : Number(process.env.OFP_PORT || 8787), async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (!isSelftest) return console.log(`open-footprint-protocol reference server on ${base} (tokens: demo-personal, demo-project)`);
  try {
    await selftest(`${base}/v1`); // any prefix works: routes match by suffix
    console.log("SELFTEST OK");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
