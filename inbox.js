// Agent inbox view of the dashboard: an inbox of sub-agent tasks, grouped by
// the prompt you gave the main agent. Open a task to read its result, mark
// it done, or send the agent a change request.

const inbox = {
  filter: "all",
  search: "",
  drafts: {},        // unsent change-request text per task
  detailKey: "",     // skip re-rendering the detail pane when nothing changed
  marking: new Set(),
};

function ib(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const STATUS_CHIP = {
  running:  ["◌", "Running", "st-running"],
  review:   ["●", "To review", "st-review"],
  failed:   ["✕", "Failed", "st-failed"],
  changes:  ["↻", "Changes requested", "st-changes"],
  done:     ["✓", "Done", "st-done"],
  archived: ["▢", "Archived", "st-done"],
};

function chipFor(t) {
  const b = flTaskBucket(t);
  const key = b === "review" && t.status === "failed" ? "failed" : b;
  const [icon, label, cls] = STATUS_CHIP[key];
  const c = ib("span", `chip ${cls}`);
  c.append(ib("span", "chip-icon", icon), document.createTextNode(label));
  return c;
}

function duration(t) {
  if (!t.startedAt) return "";
  const end = t.endedAt || Date.now();
  return flFormatDuration(end - t.startedAt);
}

function matchesFilter(t) {
  const b = flTaskBucket(t);
  if (inbox.filter === "all" ? b === "archived" : b !== inbox.filter) return false;
  if (!inbox.search) return true;
  const q = inbox.search.toLowerCase();
  return [t.title, t.agent, t.prompt, t.result, t.parentPrompt, t.cwd].some((f) => String(f || "").toLowerCase().includes(q));
}

// ---- bridge status bar / setup -------------------------------------------------

function renderBridgeBar(cache, settings, bar = $("bridgeBar")) {

  bar.replaceChildren();
  const status = ib("div", "bridge-status " + (cache.ok ? "ok" : "off"));
  status.append(ib("span", "dot"));
  if (globalThis.FL_DEMO_BRIDGE) status.append(document.createTextNode("Demo bridge · sample tasks"));
  else if (cache.ok) status.append(document.createTextNode(`Connected to bridge · synced ${flTimeAgo(cache.lastSync)}`));
  else status.append(document.createTextNode(settings.bridgeToken ? `Not connected: ${cache.error || "bridge not running"}` : "Not paired with a bridge yet"));
  bar.append(status);

  if (!cache.ok && !globalThis.FL_DEMO_BRIDGE) {
    const setup = ib("div", "card setup");
    setup.append(ib("h2", null, "Connect your agents"));
    const ol = ib("ol", "steps");
    const step = (title, code, note) => {
      const li = ib("li");
      li.append(ib("b", null, title));
      if (code) li.append(ib("code", "cmd", code));
      if (note) li.append(ib("small", "muted", note));
      ol.append(li);
    };
    step("Start the bridge in a terminal, from the extension folder", "node bridge/server.mjs", "Keep it running. It prints a pairing token.");
    step("Paste the pairing token", null, "Dashboard → Settings → Agent bridge.");
    step("Let Claude Code report its sub-agents (run once)", "node bridge/install-claude-hooks.mjs", "Other agent tools can POST tasks to the bridge; see the README.");
    const go = ib("a", "primary link-btn", "Open bridge settings");
    go.href = "#settings";
    setup.append(ol, go);
    bar.append(setup);
  }
}

// ---- list ---------------------------------------------------------------------

function renderTaskList(tasks, sessions, selectedId) {
  const list = $("taskList");
  const visible = tasks.filter(matchesFilter);
  if (!visible.length) {
    const empty = ib("div", "empty");
    empty.append(ib("div", "empty-icon", "✉"),
      ib("p", null, tasks.length ? "No tasks match this filter." : "No sub-agent tasks yet. When an agent hands work to a sub-agent, it shows up here."));
    list.replaceChildren(empty);
    return;
  }
  // group by the main prompt (per session)
  const groups = new Map();
  for (const t of visible) {
    const k = `${t.sessionId}\u0000${t.parentPrompt || ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const ordered = [...groups.values()]
    .map((g) => g.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)))
    .sort((a, b) => (b[0].startedAt || 0) - (a[0].startedAt || 0));

  list.replaceChildren(...ordered.map((g) => {
    const first = g[0];
    const box = ib("div", "task-group");
    const head = ib("div", "group-head");
    head.append(ib("span", "group-prompt", first.parentPrompt ? `“${first.parentPrompt.split("\n")[0]}”` : "Main agent"));
    const proj = flProjectName(first.cwd || sessions[first.sessionId]?.cwd);
    head.append(ib("span", "muted", [proj, flPlural(g.length, "task")].filter(Boolean).join(" · ")));
    box.append(head);
    for (const t of g) {
      const a = ib("a", "task-item" + (t.id === selectedId ? " on" : "") + (!t.read && t.status !== "running" ? " unread" : ""));
      a.href = `#inbox/${encodeURIComponent(t.id)}`;
      const top = ib("div", "task-top");
      top.append(ib("span", "task-title", t.title), ib("span", "task-time", flTimeAgo(t.endedAt || t.startedAt)));
      const meta = ib("div", "task-meta");
      meta.append(chipFor(t), ib("span", "tag", t.agent || "subagent"));
      if (t.modOf) meta.append(ib("span", "tag mod", "follow-up"));
      const snippet = t.status === "running" ? `Working… ${duration(t)}` : (t.error || t.result || "").replace(/\s+/g, " ").slice(0, 140);
      a.append(top, meta, ib("div", "task-snippet", snippet));
      box.append(a);
    }
    return box;
  }));
}

// ---- detail -------------------------------------------------------------------------

function block(title, ...children) {
  const b = ib("div", "block");
  if (title) b.append(ib("h3", null, title));
  b.append(...children);
  return b;
}

function changeRequestPrompt(t, text) {
  return `Please revise the result of the sub-agent task "${t.title}" (${t.agent}).\n\nRequested changes:\n${text}\n\nPrevious result:\n${t.result || t.error || ""}`;
}

async function sendFeedback(t, mode) {
  const ta = $("fbText");
  const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const btns = document.querySelectorAll(".request button");
  btns.forEach((b) => (b.disabled = true));
  try {
    const { task } = await flBridge("POST", `/api/tasks/${encodeURIComponent(t.id)}/feedback`, { text, mode, by: me.displayName });
    delete inbox.drafts[t.id];
    await flCacheTask(task);
    await flSyncAgentTasks();
    inbox.detailKey = "";
    render();
  } catch (e) {
    $("fbStatus").textContent = e.message;
    btns.forEach((b) => (b.disabled = false));
  }
}

async function patchTask(t, patch) {
  try {
    const task = await flBridge("PATCH", `/api/tasks/${encodeURIComponent(t.id)}`, patch);
    await flCacheTask(task);
  } catch (e) {
    const s = $("fbStatus");
    if (s) s.textContent = e.message;
  }
  inbox.detailKey = "";
  render();
}

const FB_STATUS = {
  pending: ["Waiting for the agent", "st-changes"],
  delivered: ["Delivered to the agent", "st-review"],
  running: ["Running in Claude Code", "st-running"],
  done: ["Done", "st-done"],
  failed: ["Failed", "st-failed"],
};

function renderDetail(t, cache) {
  const pane = $("taskDetail");
  const key = t ? `${t.id}:${t.updatedAt}:${cache.claudeAvailable}` : "none";
  if (key === inbox.detailKey) return;
  inbox.detailKey = key;

  if (!t) {
    const empty = ib("div", "empty");
    empty.append(ib("div", "empty-icon", "☰"), ib("p", null, "Select a task to read what the sub-agent did."));
    pane.replaceChildren(empty);
    return;
  }

  // head
  const head = ib("div", "detail-head");
  const chips = ib("div", "task-meta");
  chips.append(chipFor(t), ib("span", "tag", t.agent || "subagent"));
  if (t.source) chips.append(ib("span", "tag", t.source));
  const h = ib("h2", "detail-title", t.title);
  const metaBits = [
    flProjectName(t.cwd || cache.sessions[t.sessionId]?.cwd),
    t.startedAt && `started ${new Date(t.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    t.startedAt && (t.status === "running" ? `running for ${duration(t)}` : `took ${duration(t)}`),
  ].filter(Boolean);
  const actions = ib("div", "detail-actions");
  const done = ib("button", t.review === "accepted" ? "ghost" : "primary", t.review === "accepted" ? "↺ Reopen" : "✓ Mark as done");
  done.disabled = t.status === "running";
  done.onclick = () => patchTask(t, { review: t.review === "accepted" ? "none" : "accepted", read: true });
  const unread = ib("button", "ghost", t.read ? "Mark unread" : "Mark read");
  unread.onclick = () => patchTask(t, { read: !t.read });
  const arch = ib("button", "ghost", t.archived ? "Unarchive" : "Archive");
  arch.onclick = () => patchTask(t, { archived: !t.archived });
  actions.append(done, unread, arch);
  head.append(chips, h, ib("div", "muted", metaBits.join(" · ")), actions);

  const parts = [head];

  if (t.modOf) {
    const orig = cache.tasks[t.modOf];
    const a = ib("a", "link", `↩ Follow-up to “${orig?.title || "an earlier task"}”`);
    a.href = `#inbox/${encodeURIComponent(t.modOf)}`;
    parts.push(block(null, a));
  }

  if (t.parentPrompt) parts.push(block("Your prompt to the main agent", ib("blockquote", null, t.parentPrompt)));

  if (t.prompt) {
    const d = ib("details", "block");
    d.append(ib("summary", null, "Instructions the main agent gave this sub-agent"), ib("pre", "prompt", t.prompt));
    parts.push(d);
  }

  // result
  const resHead = ib("div", "block-head");
  resHead.append(ib("h3", null, t.status === "failed" ? "Error" : "Result"));
  if (t.result || t.error) {
    const copy = ib("button", "ghost small", "Copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(t.result || t.error);
      copy.textContent = "Copied ✓";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    };
    resHead.append(copy);
  }
  const res = ib("pre", "result" + (t.status === "failed" ? " error" : ""));
  res.textContent = t.status === "running"
    ? (t.launchNote ? `${t.launchNote}\n\nRunning in the background… the result will appear here.` : "Still working… the result will appear here when the sub-agent finishes.")
    : t.error || t.result || "(The sub-agent returned no text.)";
  const resBlock = ib("div", "block");
  resBlock.append(resHead, res);
  parts.push(resBlock);

  // change request (only for users allowed to send them)
  const req = ib("div", "block request");
  if (!flCan(me, "requestChanges")) req.hidden = true;
  req.append(ib("h3", null, "Request changes"));
  const ta = ib("textarea");
  ta.id = "fbText";
  ta.placeholder = "Describe what should change, e.g. “Also cover token expiry and use the existing test helpers.”";
  ta.value = inbox.drafts[t.id] || "";
  ta.oninput = () => (inbox.drafts[t.id] = ta.value);
  const row = ib("div", "actions");
  const next = ib("button", "primary", "Send to agent");
  next.onclick = () => sendFeedback(t, "next-turn");
  row.append(next);
  const canRun = cache.claudeAvailable && t.source === "claude-code";
  if (canRun) {
    const run = ib("button", "ghost", "▶ Run now in Claude Code");
    run.title = "Resumes this Claude Code session in the background (as a fork) with your request";
    run.onclick = () => sendFeedback(t, "run-now");
    row.append(run);
  }
  const copyP = ib("button", "ghost", "Copy as prompt");
  copyP.onclick = async () => {
    if (!ta.value.trim()) { ta.focus(); return; }
    await navigator.clipboard.writeText(changeRequestPrompt(t, ta.value.trim()));
    copyP.textContent = "Copied ✓";
    setTimeout(() => (copyP.textContent = "Copy as prompt"), 1200);
  };
  row.append(copyP);
  const st = ib("span", "muted");
  st.id = "fbStatus";
  row.append(st);
  req.append(ta, row, ib("small", "muted hint",
    "“Send to agent” queues your request. Claude Code picks it up when the main agent finishes its current turn, or with your next prompt in that session." +
    (canRun ? " “Run now” starts it immediately in a background fork of the session." : "") +
    " “Copy as prompt” lets you paste it into any agent yourself."));
  parts.push(req);

  // history
  if (t.feedback?.length) {
    const ul = ib("ul", "history");
    for (const fb of [...t.feedback].reverse()) {
      const li = ib("li");
      const [label, cls] = FB_STATUS[fb.status] || [fb.status, ""];
      const top = ib("div", "task-top");
      const chip = ib("span", `chip ${cls}`, label);
      top.append(chip, ib("span", "task-time", flTimeAgo(fb.deliveredAt || fb.createdAt)));
      li.append(top, ib("p", null, fb.text));
      if (fb.by) li.append(ib("small", "muted", `Requested by ${fb.by}`));
      if (fb.note) li.append(ib("small", "muted", fb.note));
      if (fb.resultTaskId) {
        const a = ib("a", "link", "Open the result →");
        a.href = `#inbox/${encodeURIComponent(fb.resultTaskId)}`;
        li.append(a);
      }
      ul.append(li);
    }
    parts.push(block("Change requests", ul));
  }

  pane.replaceChildren(...parts);
  pane.scrollTop = 0;
}

// ---- view entry point ------------------------------------------------------------

function renderInboxKpis(tasks) {
  const c = flAgentCounts(Object.fromEntries(tasks.map((t) => [t.id, t])));
  $("inboxKpis").replaceChildren(
    kpi("To review", String(c.review), `${c.unread} unread`, "g-brand"),
    kpi("Running", String(c.running), "sub-agents working now", "g-idle"),
    kpi("Changes requested", String(c.changes), "sent back to the agent", "g-aiWaiting"),
    kpi("Done", String(c.done), "reviewed and accepted", "g-active"),
  );
}

async function renderInbox(selectedId) {
  const settings = await flGetSettings();
  const { cache } = await flSyncAgentTasks();
  const tasks = Object.values(cache.tasks);
  renderBridgeBar(cache, settings);
  renderInboxKpis(tasks);
  renderTaskList(tasks, cache.sessions, selectedId);
  const t = selectedId ? cache.tasks[selectedId] : null;
  renderDetail(t, cache);
  $("taskDetail").classList.toggle("has-task", !!t);
  // opening a finished task marks it read
  if (t && !t.read && t.status !== "running" && !inbox.marking.has(t.id)) {
    inbox.marking.add(t.id);
    flBridge("PATCH", `/api/tasks/${encodeURIComponent(t.id)}`, { read: true })
      .then(flCacheTask).catch(() => {}).finally(() => inbox.marking.delete(t.id));
  }
  updateNavCount();
}

// Called by dashboard.js once its helpers ($, kpi, render) exist.
function initInbox() {
  $("inboxSearch").addEventListener("input", (e) => { inbox.search = e.target.value.trim(); render(); });
  $("inboxFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    inbox.filter = b.dataset.f;
    for (const x of $("inboxFilter").children) x.classList.toggle("on", x === b);
    render();
  });
}
