#!/usr/bin/env node
// Focus Ledger agent bridge.
//
// A tiny local server (no dependencies) that collects sub-agent tasks from
// agent tools (Claude Code hooks, or anything that can POST JSON) and serves
// them to the Chrome extension's Agent inbox. It also holds the change
// requests you make in the inbox until the agent picks them up, and enforces
// your permission rules: when a rule says "ask", the agent's tool call waits
// here until you approve or deny it in the extension's Permission inbox.
//
//   node bridge/server.mjs
//
// Listens on 127.0.0.1 only. Every request must carry the pairing token
// (printed at startup, stored in ~/.focus-ledger/token), and browser requests
// are only accepted from chrome-extension:// origins, so web pages can't
// read your tasks or inject instructions into your agents.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.FOCUS_LEDGER_PORT) || 47321;
const DIR = process.env.FOCUS_LEDGER_DIR || path.join(os.homedir(), ".focus-ledger");
const DB_FILE = path.join(DIR, "tasks.json");
const TOKEN_FILE = path.join(DIR, "token");
const RULES_FILE = path.join(DIR, "rules.json");
const MAX_TASKS = 1000;
const MAX_PERMISSIONS = 1000;
const MAX_TEXT = 200_000; // chars kept per prompt/result
const CLAUDE_CMD = process.env.FOCUS_LEDGER_CLAUDE_CMD || "claude";
// Extra flags for "Run now" (e.g. "--permission-mode acceptEdits"). Split on spaces; no shell parsing.
const CLAUDE_ARGS = (process.env.FOCUS_LEDGER_CLAUDE_ARGS || "").split(" ").filter(Boolean);
const RUN_TIMEOUT_MS = 15 * 60_000;

fs.mkdirSync(DIR, { recursive: true });

// ---- token ------------------------------------------------------------------

let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
} catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

// ---- storage ----------------------------------------------------------------

let db = { sessions: {}, tasks: {}, permissions: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const [coll, max] of [[db.tasks, MAX_TASKS], [db.permissions, MAX_PERMISSIONS]]) {
      const ids = Object.keys(coll);
      if (ids.length <= max) continue;
      ids.sort((a, b) => coll[a].updatedAt - coll[b].updatedAt)
        .slice(0, ids.length - max)
        .forEach((id) => delete coll[id]);
    }
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE); // atomic replace
  }, 150);
}

const clip = (s) => (s == null ? "" : String(s).slice(0, MAX_TEXT));
const now = () => Date.now();
const newId = () => crypto.randomUUID();

// Long-poll support: anything that changes bumps `version` and wakes waiters.
let version = 1;
const waiters = new Set();
function bump() {
  version++;
  for (const w of waiters) w();
  waiters.clear();
}
function waitForChange(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    waiters.add(done);
  });
}

function touch(item) {
  item.updatedAt = now();
  save();
  bump();
  return item;
}

// ---- Claude CLI availability (for "Run now") ------------------------------

let claudeAvailable = false;
try {
  const r = spawnSync(CLAUDE_CMD, ["--version"], { shell: process.platform === "win32", timeout: 10_000, encoding: "utf8" });
  claudeAvailable = r.status === 0;
} catch {}

// ---- event handling -----------------------------------------------------------

// Events agents send. All fields optional except `event`.
//   session.prompt   { sessionId, prompt, cwd, source }
//   task.started     { taskId, sessionId, agent, title, prompt, cwd, source, background }
//   task.agent       { sessionId, agentId, agent }               (links a running agent id)
//   task.completed   { taskId | agentId, sessionId, result, final }
//   task.failed      { taskId | agentId, sessionId, error }
function handleEvent(e) {
  const t = now();
  const sid = e.sessionId ? String(e.sessionId) : "default";
  const session = (db.sessions[sid] ||= { id: sid, createdAt: t });
  if (e.cwd) session.cwd = String(e.cwd);
  if (e.source) session.source = String(e.source);
  session.updatedAt = t;

  switch (e.event) {
    case "session.prompt": {
      session.lastPrompt = clip(e.prompt);
      session.lastPromptAt = t;
      save();
      return { ok: true };
    }
    case "task.started": {
      const id = String(e.taskId || newId());
      const task = (db.tasks[id] ||= {
        id, sessionId: sid, createdAt: t, read: false, review: "none", feedback: [],
      });
      Object.assign(task, {
        status: "running",
        agent: String(e.agent || task.agent || "subagent"),
        title: clip(e.title || task.title || "Untitled task").slice(0, 300),
        prompt: clip(e.prompt ?? task.prompt),
        parentPrompt: task.parentPrompt ?? session.lastPrompt ?? "",
        cwd: e.cwd || task.cwd || session.cwd || "",
        source: e.source || task.source || session.source || "custom",
        background: !!e.background,
        startedAt: task.startedAt || t,
      });
      if (e.modOf) task.modOf = String(e.modOf);
      touch(task);
      return { ok: true, taskId: id };
    }
    case "task.agent": {
      // SubagentStart gives an agent id but not the tool call id: attach it to
      // the oldest running task of that type in this session that has none.
      const task = Object.values(db.tasks)
        .filter((x) => x.sessionId === sid && x.status === "running" && !x.agentId && (!e.agent || x.agent === e.agent))
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (task) { task.agentId = String(e.agentId); touch(task); }
      return { ok: true, taskId: task?.id };
    }
    case "task.completed":
    case "task.failed": {
      const task = findTask(e, sid);
      if (!task) return { ok: false, error: "unknown task" };
      if (e.event === "task.failed") {
        task.status = "failed";
        task.error = clip(e.error);
      } else {
        // A background agent's tool call returns right away with a "launched"
        // message; only its final message (final: true) completes it.
        if (task.background && !e.final) {
          if (e.result) task.launchNote = clip(e.result);
          touch(task);
          return { ok: true, taskId: task.id };
        }
        task.status = "completed";
        if (e.result || !task.result) task.result = clip(e.result);
      }
      task.endedAt = t;
      task.read = false;
      touch(task);
      return { ok: true, taskId: task.id };
    }
    default:
      return { ok: false, error: `unknown event "${e.event}"` };
  }
}

function findTask(e, sid) {
  if (e.taskId && db.tasks[e.taskId]) return db.tasks[e.taskId];
  if (e.agentId) return Object.values(db.tasks).find((x) => x.agentId === String(e.agentId));
  // last resort: the newest running task in this session
  return Object.values(db.tasks)
    .filter((x) => x.sessionId === sid && x.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

// ---- change requests ------------------------------------------------------------

function changeRequestText(task, fb) {
  return [
    `The user reviewed the result of the sub-agent task "${task.title}" (agent: ${task.agent})`,
    `in their Focus Ledger inbox and asked for these changes:`,
    "",
    fb.text,
    "",
    "Please make these changes, using a sub-agent again if that fits.",
  ].join("\n");
}

function addFeedback(task, text, mode, by) {
  const fb = { id: newId(), text: clip(text), mode, by: by ? String(by).slice(0, 100) : "", createdAt: now(), status: "pending" };
  task.feedback.push(fb);
  task.review = "changes_requested";
  touch(task);
  if (mode === "run-now") runNow(task, fb);
  return fb;
}

// Hand pending change requests for a session to the agent (called by hooks).
function claimFeedback(sessionId) {
  const items = [];
  for (const task of Object.values(db.tasks)) {
    if (task.sessionId !== sessionId) continue;
    for (const fb of task.feedback) {
      if (fb.status !== "pending" || fb.mode !== "next-turn") continue;
      fb.status = "delivered";
      fb.deliveredAt = now();
      items.push({ taskId: task.id, feedbackId: fb.id, title: task.title, text: changeRequestText(task, fb) });
      touch(task);
    }
  }
  return items;
}

// "Run now": resume the Claude Code session headlessly in a fork, with the
// change request as the prompt (sent on stdin, never through a shell string).
function runNow(task, fb) {
  const valid = /^[0-9a-f-]{8,64}$/i.test(task.sessionId);
  if (!claudeAvailable || task.source !== "claude-code" || !valid) {
    fb.status = "pending";
    fb.mode = "next-turn";
    fb.note = "Couldn't run now (Claude Code CLI not found or not a Claude Code task). It will be delivered at the agent's next turn instead.";
    touch(task);
    return;
  }
  const modId = newId();
  const mod = {
    id: modId, sessionId: task.sessionId, createdAt: now(), startedAt: now(), read: false, review: "none", feedback: [],
    status: "running", agent: "claude (resumed)", title: `Changes: ${task.title}`.slice(0, 300),
    prompt: fb.text, parentPrompt: fb.text, cwd: task.cwd, source: "claude-code", modOf: task.id,
  };
  db.tasks[modId] = mod;
  fb.status = "running";
  fb.resultTaskId = modId;
  touch(mod);
  touch(task);

  const args = ["-p", "--resume", task.sessionId, "--fork-session", "--output-format", "json", ...CLAUDE_ARGS];
  let out = "", err = "";
  let child;
  try {
    child = spawn(CLAUDE_CMD, args, {
      cwd: task.cwd && fs.existsSync(task.cwd) ? task.cwd : os.homedir(),
      shell: process.platform === "win32", // claude may be a .cmd shim; args are fixed constants + a validated id
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return finish(false, String(e));
  }
  const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => finish(false, String(e)));
  child.on("close", (code) => {
    clearTimeout(timer);
    let result = out.trim();
    try {
      const j = JSON.parse(out);
      result = j.result ?? result;
      if (j.session_id) mod.forkSessionId = j.session_id;
      if (j.is_error) return finish(false, result || err);
    } catch {}
    finish(code === 0, code === 0 ? result : err || result || `exit code ${code}`);
  });
  child.stdin.end(changeRequestText(task, fb));

  function finish(ok, text) {
    if (mod.status !== "running") return;
    mod.status = ok ? "completed" : "failed";
    mod[ok ? "result" : "error"] = clip(text);
    mod.endedAt = now();
    fb.status = ok ? "done" : "failed";
    touch(mod);
    touch(task);
  }
}

// ---- permission rules --------------------------------------------------------------
//
// A rule matches a tool call by tool name and (optionally) text in the call:
// the shell command, file path, URL, search query, or sub-agent prompt.
//   { id, name, enabled, tools: "Bash,PowerShell" | "Write,Edit" | "mcp__*" | "*",
//     match: "git push", matchType: "contains" | "regex",
//     scope: "any" | "main" | "subagents", action: "ask" | "deny" | "allow" }
// The first enabled matching rule wins. No match = the agent's normal behavior.

const DEFAULT_RULES = {
  timeoutSec: 300,      // how long an "ask" waits for you
  onTimeout: "deny",    // "deny" or "ask" (fall back to the agent's own prompt)
  rules: [
    { id: "r-delete", name: "Ask before deleting files", enabled: true, tools: "Bash,PowerShell",
      match: String.raw`(^|[\s;&|(])(rm|rmdir|del|erase|rd|Remove-Item|unlink)(\s|$)`, matchType: "regex", scope: "any", action: "ask" },
    { id: "r-push", name: "Ask before git push", enabled: true, tools: "Bash,PowerShell",
      match: String.raw`git\s+push`, matchType: "regex", scope: "any", action: "ask" },
    { id: "r-install", name: "Ask before installing packages", enabled: true, tools: "Bash,PowerShell",
      match: String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bwinget\s+install\b`, matchType: "regex", scope: "any", action: "ask" },
    { id: "r-env", name: "Never read .env files", enabled: true, tools: "Read,Bash,PowerShell",
      match: String.raw`(^|[\\/\s"'])\.env(\.[\w-]+)?($|[\s"'])`, matchType: "regex", scope: "any", action: "deny" },
    { id: "r-web", name: "Ask before sub-agents fetch web pages", enabled: false, tools: "WebFetch",
      match: "", matchType: "contains", scope: "subagents", action: "ask" },
  ],
};

let rulesDoc = DEFAULT_RULES;
try {
  rulesDoc = { ...DEFAULT_RULES, ...JSON.parse(fs.readFileSync(RULES_FILE, "utf8")) };
} catch {}

function saveRules(doc) {
  const rules = (Array.isArray(doc.rules) ? doc.rules : []).slice(0, 200).map((r, i) => ({
    id: String(r.id || `r-${newId().slice(0, 8)}`),
    name: String(r.name || `Rule ${i + 1}`).slice(0, 120),
    enabled: r.enabled !== false,
    tools: String(r.tools || "*").slice(0, 300),
    match: String(r.match || "").slice(0, 1000),
    matchType: r.matchType === "regex" ? "regex" : "contains",
    scope: ["main", "subagents"].includes(r.scope) ? r.scope : "any",
    action: ["deny", "allow"].includes(r.action) ? r.action : "ask",
  }));
  for (const r of rules) {
    if (r.matchType === "regex") new RegExp(r.match, "i"); // throws on a bad pattern -> 400
  }
  rulesDoc = {
    timeoutSec: Math.min(840, Math.max(15, Number(doc.timeoutSec) || DEFAULT_RULES.timeoutSec)),
    onTimeout: doc.onTimeout === "ask" ? "ask" : "deny",
    rules,
    updatedAt: now(),
    updatedBy: doc.updatedBy ? String(doc.updatedBy).slice(0, 100) : "",
  };
  fs.writeFileSync(RULES_FILE, JSON.stringify(rulesDoc, null, 2));
  bump();
  return rulesDoc;
}

// The part of a tool call that rules match against.
function describeCall(tool, input = {}) {
  if (/^(Bash|PowerShell)$/.test(tool)) return String(input.command || "");
  if (["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) return String(input.file_path || input.notebook_path || "");
  if (tool === "WebFetch") return String(input.url || "");
  if (tool === "WebSearch") return String(input.query || "");
  if (tool === "Agent" || tool === "Task") return `${input.description || ""}\n${input.prompt || ""}`.trim();
  return JSON.stringify(input);
}

function toolMatches(spec, tool) {
  return String(spec).split(",").map((x) => x.trim()).filter(Boolean)
    .some((x) => x === "*" || x === tool || (x.endsWith("*") && tool.startsWith(x.slice(0, -1))));
}

function ruleMatches(rule, tool, text, isSub) {
  if (!rule.enabled) return false;
  if ((rule.scope === "subagents" && !isSub) || (rule.scope === "main" && isSub)) return false;
  if (!toolMatches(rule.tools || "*", tool)) return false;
  if (!rule.match) return true;
  if (rule.matchType === "regex") {
    try { return new RegExp(rule.match, "i").test(text); } catch { return false; }
  }
  return text.toLowerCase().includes(rule.match.toLowerCase());
}

// Called by the PreToolUse hook for every tool call.
function checkPermission(e) {
  const tool = String(e.toolName || "");
  const text = describeCall(tool, e.toolInput || {}).slice(0, 20_000);
  const isSub = !!e.agentId;
  const rule = rulesDoc.rules.find((r) => ruleMatches(r, tool, text, isSub));
  if (!rule) return { decision: "none" };
  if (rule.action === "allow") return { decision: "allow", reason: `Allowed by the Focus Ledger rule “${rule.name}”.` };

  const sid = e.sessionId ? String(e.sessionId) : "default";
  const session = db.sessions[sid];
  const req = {
    id: newId(), sessionId: sid, cwd: String(e.cwd || session?.cwd || ""), source: String(e.source || "custom"),
    toolName: tool, summary: clip(text), toolInput: clip(JSON.stringify(e.toolInput || {}, null, 2)),
    agent: String(e.agentType || (isSub ? "subagent" : "main agent")), isSubagent: isSub,
    ruleId: rule.id, ruleName: rule.name, parentPrompt: session?.lastPrompt || "",
    createdAt: now(), read: false,
  };
  if (rule.action === "deny") {
    Object.assign(req, { status: "blocked", decidedAt: now(), decidedBy: "rule" });
    db.permissions[req.id] = touch(req);
    return { decision: "deny", id: req.id, reason: `Blocked by the Focus Ledger rule “${rule.name}”. Don't retry this; ask the user if you need it.` };
  }
  Object.assign(req, { status: "pending", expiresAt: now() + rulesDoc.timeoutSec * 1000, onTimeout: rulesDoc.onTimeout });
  db.permissions[req.id] = touch(req);
  return { decision: "pending", id: req.id, expiresAt: req.expiresAt };
}

function expirePending() {
  for (const r of Object.values(db.permissions)) {
    if (r.status === "pending" && now() > r.expiresAt) {
      r.status = "expired";
      r.decidedAt = now();
      touch(r);
    }
  }
}
setInterval(expirePending, 2000);

function decide(req, decision, note, by) {
  if (req.status !== "pending") throw new Error(`This request is already ${req.status}.`);
  req.status = decision === "allow" ? "approved" : "denied";
  req.note = clip(note).slice(0, 2000);
  req.decidedBy = String(by || "").slice(0, 100);
  req.decidedAt = now();
  req.read = true;
  return touch(req);
}

// ---- HTTP ------------------------------------------------------------------------

function send(res, code, body, origin) {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin?.startsWith("chrome-extension://")) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "content-type, x-focus-ledger-token";
    headers["access-control-allow-methods"] = "GET, POST, PATCH, PUT, OPTIONS";
  }
  res.writeHead(code, headers);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, data = "";
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error("body too large")); req.destroy(); }
      else data += c;
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON")); }
    });
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  // Browser requests are only allowed from extensions; hooks/CLIs send no Origin.
  if (origin && !origin.startsWith("chrome-extension://")) return send(res, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return send(res, 204, undefined, origin);
  if (!safeEqual(req.headers["x-focus-ledger-token"], TOKEN)) return send(res, 401, { error: "bad or missing token" }, origin);

  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, version: 2, claudeAvailable, tasks: Object.keys(db.tasks).length, rules: rulesDoc.rules.filter((r) => r.enabled).length }, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readBody(req);
      const events = Array.isArray(body) ? body : [body];
      return send(res, 200, events.map(handleEvent), origin);
    }
    if (req.method === "GET" && url.pathname === "/api/changes") {
      // long-poll: returns as soon as anything changes, or after `timeout` seconds
      const since = Number(url.searchParams.get("since")) || 0;
      const timeout = Math.min(25, Math.max(1, Number(url.searchParams.get("timeout")) || 20)) * 1000;
      if (version <= since) await waitForChange(timeout);
      return send(res, 200, { version }, origin);
    }
    if (req.method === "GET" && url.pathname === "/api/rules") return send(res, 200, rulesDoc, origin);
    if (req.method === "PUT" && url.pathname === "/api/rules") return send(res, 200, saveRules(await readBody(req)), origin);
    if (req.method === "POST" && url.pathname === "/api/permissions/check") {
      return send(res, 200, checkPermission(await readBody(req)), origin);
    }
    if (req.method === "GET" && url.pathname === "/api/permissions") {
      const since = Number(url.searchParams.get("since")) || 0;
      return send(res, 200, { permissions: Object.values(db.permissions).filter((x) => x.updatedAt > since), now: now() }, origin);
    }
    if (parts[0] === "api" && parts[1] === "permissions" && parts[2]) {
      const p = db.permissions[parts[2]];
      if (!p) return send(res, 404, { error: "no such request" }, origin);
      if (req.method === "GET" && parts[3] === "wait") {
        const timeout = Math.min(25, Math.max(1, Number(url.searchParams.get("timeout")) || 20)) * 1000;
        const until = now() + timeout;
        while (p.status === "pending" && now() < until) await waitForChange(until - now());
        return send(res, 200, p, origin);
      }
      if (req.method === "POST" && parts[3] === "decide") {
        const body = await readBody(req);
        if (!["allow", "deny"].includes(body.decision)) return send(res, 400, { error: "decision must be allow or deny" }, origin);
        return send(res, 200, decide(p, body.decision, body.note, body.by), origin);
      }
      if (req.method === "PATCH" && parts.length === 3) {
        const body = await readBody(req);
        if ("read" in body) p.read = !!body.read;
        if ("archived" in body) p.archived = !!body.archived;
        return send(res, 200, touch(p), origin);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const since = Number(url.searchParams.get("since")) || 0;
      const tasks = Object.values(db.tasks).filter((x) => x.updatedAt > since);
      const sessions = Object.fromEntries(Object.values(db.sessions).map((s) => [s.id, { id: s.id, cwd: s.cwd, source: s.source }]));
      return send(res, 200, { tasks, sessions, now: now(), claudeAvailable }, origin);
    }
    if (parts[0] === "api" && parts[1] === "tasks" && parts[2]) {
      const task = db.tasks[parts[2]];
      if (!task) return send(res, 404, { error: "no such task" }, origin);
      if (req.method === "PATCH" && parts.length === 3) {
        const body = await readBody(req);
        if ("read" in body) task.read = !!body.read;
        if ("review" in body && ["none", "accepted", "changes_requested"].includes(body.review)) task.review = body.review;
        if ("archived" in body) task.archived = !!body.archived;
        return send(res, 200, touch(task), origin);
      }
      if (req.method === "POST" && parts[3] === "feedback") {
        const body = await readBody(req);
        const text = String(body.text || "").trim();
        if (!text) return send(res, 400, { error: "text required" }, origin);
        const mode = body.mode === "run-now" ? "run-now" : "next-turn";
        return send(res, 200, { feedback: addFeedback(task, text, mode, body.by), task }, origin);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/feedback/claim") {
      const body = await readBody(req);
      return send(res, 200, { items: claimFeedback(String(body.sessionId || "")) }, origin);
    }
    send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    send(res, 400, { error: e.message }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Focus Ledger bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Pairing token: ${TOKEN}`);
  console.log(`  -> paste it into the extension: Dashboard > Settings > Agent bridge`);
  console.log(`Data: ${DB_FILE}`);
  console.log(`"Run now" for change requests: ${claudeAvailable ? "available" : "unavailable (Claude Code CLI not found on PATH)"}`);
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use; is the bridge already running?` : e);
  process.exit(1);
});
