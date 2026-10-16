#!/usr/bin/env node
// Adds (or removes) the Focus Ledger hook in your Claude Code user settings,
// ~/.claude/settings.json, so every Claude Code session (terminal, IDE or the
// desktop app's Code tab) reports its sub-agent tasks to the bridge.
//
//   node bridge/install-claude-hooks.mjs            install
//   node bridge/install-claude-hooks.mjs --print    show the JSON without writing
//   node bridge/install-claude-hooks.mjs --uninstall
//
// Your existing settings and hooks are kept; a backup is written first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "hooks", "claude-code-hook.mjs").replace(/\\/g, "/");
const command = `node "${hookPath}"`;
const MARK = "claude-code-hook.mjs";
const EVENTS = {
  UserPromptSubmit: undefined,
  PreToolUse: "*", // permission rules apply to every tool
  PostToolUse: "Agent|Task",
  SubagentStart: undefined,
  SubagentStop: undefined,
  Stop: undefined,
};

const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
const args = process.argv.slice(2);

function ours(group) {
  return (group.hooks || []).some((h) => String(h.command || "").includes(MARK));
}

function strip(settings) {
  for (const ev of Object.keys(settings.hooks || {})) {
    settings.hooks[ev] = settings.hooks[ev].filter((g) => !ours(g));
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}

const snippet = { hooks: {} };
for (const [ev, matcher] of Object.entries(EVENTS)) {
  // PreToolUse may wait for your approval in the Permission inbox (up to 14 min).
  const timeout = ev === "PreToolUse" ? 900 : 10;
  snippet.hooks[ev] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] }];
}

if (args.includes("--print")) {
  console.log(JSON.stringify(snippet, null, 2));
  process.exit(0);
}

let settings = {};
if (fs.existsSync(settingsFile)) {
  const raw = fs.readFileSync(settingsFile, "utf8");
  try {
    settings = JSON.parse(raw);
  } catch {
    console.error(`Couldn't parse ${settingsFile}; not changing it. Fix the JSON or add the hooks by hand (--print).`);
    process.exit(1);
  }
  fs.writeFileSync(`${settingsFile}.focus-ledger-backup`, raw);
}

strip(settings);
if (!args.includes("--uninstall")) {
  settings.hooks ||= {};
  for (const [ev, groups] of Object.entries(snippet.hooks)) {
    settings.hooks[ev] = [...(settings.hooks[ev] || []), ...groups];
  }
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
console.log(args.includes("--uninstall")
  ? `Removed the Focus Ledger hooks from ${settingsFile}.`
  : `Added the Focus Ledger hooks to ${settingsFile}.\nNew Claude Code sessions will report sub-agent tasks. Start the bridge with: node bridge/server.mjs`);
