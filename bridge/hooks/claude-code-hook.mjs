#!/usr/bin/env node
// Claude Code hook -> Focus Ledger bridge.
//
// Register this one script for these hook events (see install-claude-hooks.mjs):
//   UserPromptSubmit  records the prompt you gave the main agent, and hands it
//                     any change requests you queued in the inbox
//   PreToolUse        (every tool) checks your permission rules, waiting for your
//                     approval when a rule says "ask"; for Agent|Task, a sub-agent task started
//   PostToolUse       (matcher Agent|Task) a sub-agent task returned its result
//   SubagentStart     links the sub-agent's id to its task
//   SubagentStop      final message of a sub-agent (needed for background agents)
//   Stop              before the main agent stops, hands it any queued change requests
//
// It never blocks or breaks Claude Code: if the bridge isn't running, it exits quietly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.FOCUS_LEDGER_DIR || path.join(os.homedir(), ".focus-ledger");
const PORT = Number(process.env.FOCUS_LEDGER_PORT) || 47321;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT_TOOLS = new Set(["Agent", "Task"]);

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

function token() {
  try { return fs.readFileSync(path.join(DIR, "token"), "utf8").trim(); } catch { return ""; }
}

async function call(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-focus-ledger-token": token() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

// The Agent tool's result can be a string, { content: [{type:"text",text}] }, etc.
function resultText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join("\n");
  if (typeof r === "object") {
    if (typeof r.text === "string") return r.text;
    if (r.content != null) return resultText(r.content);
    if (typeof r.result === "string") return r.result;
    return JSON.stringify(r, null, 2);
  }
  return String(r);
}

async function get(pathname, timeoutMs) {
  const res = await fetch(BASE + pathname, {
    headers: { "x-focus-ledger-token": token() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

// Ask the bridge whether a rule covers this tool call. For "ask" rules, wait
// (long-polling) until the user approves or denies it in the Permission inbox.
// Returns a PreToolUse decision, or null to let Claude Code decide as usual.
async function checkPermission(h, base) {
  let r;
  try {
    r = await call("/api/permissions/check", {
      ...base, toolName: h.tool_name, toolInput: h.tool_input, agentId: h.agent_id, agentType: h.agent_type,
    });
  } catch {
    return null; // bridge not running: rules aren't enforced
  }
  if (r.decision === "allow") return { permissionDecision: "allow", permissionDecisionReason: r.reason };
  if (r.decision === "deny") return { permissionDecision: "deny", permissionDecisionReason: r.reason };
  if (r.decision !== "pending") return null;

  let p = { status: "pending" };
  try {
    while (p.status === "pending" && Date.now() < r.expiresAt + 5000) {
      p = await get(`/api/permissions/${encodeURIComponent(r.id)}/wait?timeout=20`, 30_000);
    }
  } catch {
    return { permissionDecision: "ask", permissionDecisionReason: "Focus Ledger bridge stopped while waiting for approval." };
  }
  const who = p.decidedBy ? ` by ${p.decidedBy}` : "";
  const note = p.note ? ` Note from the user: "${p.note}".` : "";
  if (p.status === "approved") return { permissionDecision: "allow", permissionDecisionReason: `Approved${who} in Focus Ledger.${note}` };
  if (p.status === "denied") return { permissionDecision: "deny", permissionDecisionReason: `Denied${who} in Focus Ledger (rule “${p.ruleName}”).${note} Don't retry this without asking the user.` };
  // expired
  return p.onTimeout === "ask"
    ? { permissionDecision: "ask", permissionDecisionReason: `No answer in Focus Ledger in time (rule “${p.ruleName}”).` }
    : { permissionDecision: "deny", permissionDecisionReason: `No one approved this in Focus Ledger in time (rule “${p.ruleName}”), so it was denied.` };
}

function deliver(items) {
  return [
    `Focus Ledger: the user has ${items.length === 1 ? "a change request" : `${items.length} change requests`} for earlier sub-agent work.`,
    ...items.map((i, n) => `\n--- Request ${n + 1} ---\n${i.text}`),
  ].join("\n");
}

async function main() {
  const h = await readStdin();
  const ev = h.hook_event_name;
  const base = { sessionId: h.session_id, cwd: h.cwd, source: "claude-code" };

  if (ev === "UserPromptSubmit") {
    await call("/api/events", { ...base, event: "session.prompt", prompt: h.prompt });
    const { items } = await call("/api/feedback/claim", { sessionId: h.session_id });
    if (items.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: deliver(items) },
      }));
    }
    return;
  }

  if (ev === "PreToolUse") {
    // 1. permission rules (every tool call, main agent and sub-agents)
    const decision = await checkPermission(h, base);
    if (decision) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));
      if (decision.permissionDecision === "deny") return; // the tool won't run, so don't log a task
    }
    if (!AGENT_TOOLS.has(h.tool_name)) return;
    // 2. sub-agent task tracking
    const i = h.tool_input || {};
    await call("/api/events", {
      ...base, event: "task.started", taskId: h.tool_use_id,
      agent: i.subagent_type || i.agent_type || "general-purpose",
      title: i.description || (i.prompt || "").split("\n")[0].slice(0, 120) || "Sub-agent task",
      prompt: i.prompt || "", background: !!i.run_in_background,
    });
    return;
  }

  if (ev === "PostToolUse" && AGENT_TOOLS.has(h.tool_name)) {
    await call("/api/events", { ...base, event: "task.completed", taskId: h.tool_use_id, result: resultText(h.tool_response) });
    return;
  }

  if (ev === "SubagentStart") {
    await call("/api/events", { ...base, event: "task.agent", agentId: h.agent_id, agent: h.agent_type });
    return;
  }

  if (ev === "SubagentStop") {
    if (h.agent_id) {
      await call("/api/events", { ...base, event: "task.completed", agentId: h.agent_id, result: h.last_assistant_message || "", final: true });
    }
    return;
  }

  if (ev === "Stop") {
    const { items } = await call("/api/feedback/claim", { sessionId: h.session_id });
    if (items.length) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: deliver(items) }));
    }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
