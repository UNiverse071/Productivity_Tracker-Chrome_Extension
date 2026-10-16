// Permission requests inbox + permission rules editor.
//
// When an agent (or one of its sub-agents) is about to do something one of
// your rules covers, the bridge holds the tool call and a request lands here.
// Approve or deny it, optionally with a message for the agent. This inbox is
// separate from the Agent inbox, which shows what sub-agents are working on.

const perm = { filter: "pending", detailKey: "", notes: {} };

const PERM_STATUS = {
  pending:  ["⏳", "Waiting for you", "st-changes"],
  approved: ["✓", "Approved", "st-done"],
  denied:   ["✕", "Denied", "st-failed"],
  blocked:  ["⛔", "Blocked by rule", "st-failed"],
  expired:  ["◷", "No answer in time", "st-review"],
  archived: ["▢", "Archived", "st-review"],
};

function permChip(p) {
  const [icon, label, cls] = PERM_STATUS[flPermBucket(p)] || PERM_STATUS.expired;
  const c = ib("span", `chip ${cls}`);
  c.append(ib("span", "chip-icon", icon), document.createTextNode(label));
  return c;
}

function permFilterMatch(p) {
  const b = flPermBucket(p);
  if (perm.filter === "all") return b !== "archived";
  return b === perm.filter;
}

// ---- inbox ------------------------------------------------------------------------

function renderPermKpis(items) {
  const c = { pending: 0, approved: 0, denied: 0, blocked: 0 };
  const since = startOfDay(Date.now());
  for (const p of items) {
    const b = flPermBucket(p);
    if (b === "pending") c.pending++;
    else if ((p.decidedAt || 0) >= since && b in c) c[b]++;
  }
  $("permKpis").replaceChildren(
    kpi("Waiting for you", String(c.pending), c.pending ? "an agent is paused until you answer" : "nothing waiting", "g-unprod"),
    kpi("Approved today", String(c.approved), "", "g-active"),
    kpi("Denied today", String(c.denied), "", "g-aiWaiting"),
    kpi("Blocked by rules today", String(c.blocked), "never asked: rule says block", "g-idle"),
  );
}

function renderPermList(items, selectedId) {
  const list = $("permList");
  const visible = items.filter(permFilterMatch)
    .sort((a, b) => (flPermBucket(b) === "pending") - (flPermBucket(a) === "pending") || b.createdAt - a.createdAt);
  if (!visible.length) {
    const empty = ib("div", "empty");
    empty.append(ib("div", "empty-icon", "🛡"), ib("p", null, perm.filter === "pending"
      ? "No agent is waiting for permission right now."
      : "No permission requests here yet."));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...visible.map((p) => {
    const a = ib("a", "task-item" + (p.id === selectedId ? " on" : "") + (flPermBucket(p) === "pending" ? " unread urgent" : ""));
    a.href = `#permissions/${encodeURIComponent(p.id)}`;
    const top = ib("div", "task-top");
    top.append(ib("span", "task-title", `${p.agent} → ${p.toolName}`));
    const time = ib("span", "task-time");
    if (flPermBucket(p) === "pending") { time.classList.add("countdown"); time.dataset.expires = p.expiresAt; time.textContent = `${flTimeLeft(p.expiresAt)} left`; }
    else time.textContent = flTimeAgo(p.decidedAt || p.createdAt);
    top.append(time);
    const meta = ib("div", "task-meta");
    meta.append(permChip(p), ib("span", "tag", p.ruleName));
    a.append(top, meta, ib("div", "task-snippet mono", (p.summary || "").replace(/\s+/g, " ").slice(0, 160)));
    return a;
  }));
}

function renderPermDetail(p) {
  const pane = $("permDetail");
  const key = p ? `${p.id}:${p.updatedAt}:${flPermBucket(p)}` : "none";
  if (key === perm.detailKey) return;
  perm.detailKey = key;
  if (!p) {
    const empty = ib("div", "empty");
    empty.append(ib("div", "empty-icon", "🛡"), ib("p", null, "Select a request to see exactly what the agent wants to do."));
    pane.replaceChildren(empty);
    return;
  }
  const bucket = flPermBucket(p);
  const head = ib("div", "detail-head");
  const chips = ib("div", "task-meta");
  chips.append(permChip(p), ib("span", "tag", p.toolName), ib("span", "tag", p.isSubagent ? "sub-agent" : "main agent"));
  head.append(chips, ib("h2", "detail-title", `${p.agent} wants to use ${p.toolName}`),
    ib("div", "muted", [flProjectName(p.cwd), `asked ${new Date(p.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`].filter(Boolean).join(" · ")));
  const parts = [head];

  const what = ib("div", "block");
  what.append(ib("h3", null, { Bash: "Command", PowerShell: "Command", Read: "File", Write: "File", Edit: "File", WebFetch: "URL", WebSearch: "Search" }[p.toolName] || "Request"),
    ib("pre", "result ask", p.summary || "(no details)"));
  parts.push(what);

  parts.push(block("Why you're being asked", ib("p", "rule-line", `It matches your rule “${p.ruleName}”.`)));
  if (p.parentPrompt) parts.push(block("Your prompt to the main agent", ib("blockquote", null, p.parentPrompt)));
  if (p.toolInput) {
    const d = ib("details", "block");
    d.append(ib("summary", null, "Full tool call"), ib("pre", "prompt", p.toolInput));
    parts.push(d);
  }

  if (bucket === "pending") {
    const box = ib("div", "block request decide");
    const cd = ib("p", "countdown-line");
    const timer = ib("b", "countdown");
    timer.dataset.expires = p.expiresAt;
    timer.textContent = flTimeLeft(p.expiresAt);
    cd.append(document.createTextNode("The agent is paused. "), timer,
      document.createTextNode(` left, then it's ${p.onTimeout === "ask" ? "handed back to the agent's own permission prompt" : "denied automatically"}.`));
    box.append(ib("h3", null, "Your decision"), cd);
    if (flCan(me, "approvePermissions")) {
      const ta = ib("textarea");
      ta.id = "permNote";
      ta.placeholder = "Optional message for the agent, e.g. “Only push to the feature branch.”";
      ta.value = perm.notes[p.id] || "";
      ta.oninput = () => (perm.notes[p.id] = ta.value);
      const row = ib("div", "actions");
      const ok = ib("button", "primary approve", "✓ Approve");
      const no = ib("button", "ghost danger", "✕ Deny");
      const st = ib("span", "muted");
      const go = async (decision) => {
        ok.disabled = no.disabled = true;
        try {
          await flDecidePermission(p.id, decision, ta.value.trim(), me);
          delete perm.notes[p.id];
          perm.detailKey = "";
          render();
        } catch (e) {
          st.textContent = e.message;
          ok.disabled = no.disabled = false;
        }
      };
      ok.onclick = () => go("allow");
      no.onclick = () => go("deny");
      row.append(ok, no, st);
      box.append(ta, row);
    } else {
      box.append(ib("p", "muted", "You don't have permission to answer requests. Ask your admin."));
    }
    parts.push(box);
  } else {
    const verdict = {
      approved: `Approved by ${p.decidedBy || "someone"}`,
      denied: `Denied by ${p.decidedBy || "someone"}`,
      blocked: "Blocked automatically by the rule. The agent was told not to retry.",
      expired: p.onTimeout === "ask" ? "Nobody answered in time, so the agent's own permission prompt took over." : "Nobody answered in time, so it was denied.",
    }[bucket] || "";
    const b = block("Outcome", ib("p", null, `${verdict}${p.decidedAt ? ` · ${flTimeAgo(p.decidedAt)}` : ""}`));
    if (p.note) b.append(ib("blockquote", null, p.note));
    parts.push(b);
  }

  const arch = ib("button", "ghost small", p.archived ? "Unarchive" : "Archive");
  arch.onclick = async () => {
    try { await flCachePermission(await flBridge("PATCH", `/api/permissions/${encodeURIComponent(p.id)}`, { archived: !p.archived })); } catch {}
    perm.detailKey = "";
    render();
  };
  if (bucket !== "pending") {
    const actions = ib("div", "detail-actions");
    actions.append(arch);
    head.append(actions);
  }

  pane.replaceChildren(...parts);
}

async function renderPermissions(selectedId) {
  const settings = await flGetSettings();
  const { cache } = await flSyncPermissions();
  renderBridgeBar({ ...cache, claudeAvailable: false }, settings, $("permBridgeBar"));
  const items = Object.values(cache.items);
  renderPermKpis(items);
  renderPermList(items, selectedId);
  renderPermDetail(selectedId ? cache.items[selectedId] : null);
  updateNavCount();
}

// ---- rules editor (admin) -------------------------------------------------------------

const RULE_ACTIONS = { ask: "Ask me first", deny: "Always block", allow: "Always allow" };
const RULE_SCOPES = { any: "Main agent and sub-agents", main: "Main agent only", subagents: "Sub-agents only" };
let rulesDraft = null;

// Same matching as bridge/server.mjs, for the "Try it" box.
function clientToolMatches(spec, tool) {
  return String(spec).split(",").map((x) => x.trim()).filter(Boolean)
    .some((x) => x === "*" || x === tool || (x.endsWith("*") && tool.startsWith(x.slice(0, -1))));
}
function clientRuleMatches(r, tool, text, isSub) {
  if (!r.enabled) return false;
  if ((r.scope === "subagents" && !isSub) || (r.scope === "main" && isSub)) return false;
  if (!clientToolMatches(r.tools || "*", tool)) return false;
  if (!r.match) return true;
  if (r.matchType === "regex") { try { return new RegExp(r.match, "i").test(text); } catch { return false; } }
  return text.toLowerCase().includes(r.match.toLowerCase());
}

function select(options, value, onChange) {
  const s = ib("select");
  for (const [v, label] of Object.entries(options)) {
    const o = ib("option", null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.onchange = () => onChange(s.value);
  return s;
}

function renderRuleRows() {
  const wrap = $("ruleRows");
  wrap.replaceChildren(...rulesDraft.rules.map((r, i) => {
    const row = ib("div", "rule-row" + (r.enabled ? "" : " off"));
    const top = ib("div", "rule-top");
    const en = ib("input", "switch");
    en.type = "checkbox";
    en.checked = r.enabled;
    en.title = "Enabled";
    en.onchange = () => { r.enabled = en.checked; row.classList.toggle("off", !r.enabled); };
    const name = ib("input", "rule-name");
    name.value = r.name;
    name.placeholder = "Rule name";
    name.oninput = () => (r.name = name.value);
    const act = select(RULE_ACTIONS, r.action, (v) => { r.action = v; row.dataset.action = v; });
    row.dataset.action = r.action;
    const tools = ib("div", "rule-btns");
    const up = ib("button", "ghost small", "↑"); up.title = "Move up (rules are checked top to bottom)";
    const down = ib("button", "ghost small", "↓"); down.title = "Move down";
    const del = ib("button", "ghost small danger", "Delete");
    up.disabled = i === 0;
    down.disabled = i === rulesDraft.rules.length - 1;
    up.onclick = () => { [rulesDraft.rules[i - 1], rulesDraft.rules[i]] = [rulesDraft.rules[i], rulesDraft.rules[i - 1]]; renderRuleRows(); };
    down.onclick = () => { [rulesDraft.rules[i + 1], rulesDraft.rules[i]] = [rulesDraft.rules[i], rulesDraft.rules[i + 1]]; renderRuleRows(); };
    del.onclick = () => { rulesDraft.rules.splice(i, 1); renderRuleRows(); };
    tools.append(up, down, del);
    top.append(en, name, act, tools);

    const grid = ib("div", "rule-grid");
    const f = (label, el, hint) => {
      const l = ib("label", "rule-field");
      l.append(ib("span", null, label), el);
      if (hint && i === 0) l.append(ib("small", "muted", hint)); // explain once, on the first rule
      return l;
    };
    const toolIn = ib("input");
    toolIn.value = r.tools;
    toolIn.placeholder = "Bash,PowerShell";
    toolIn.oninput = () => (r.tools = toolIn.value);
    const matchIn = ib("input", "mono");
    matchIn.value = r.match;
    matchIn.placeholder = "empty = every call of these tools";
    matchIn.oninput = () => (r.match = matchIn.value);
    grid.append(
      f("Tools", toolIn, "Comma-separated: Bash, PowerShell, Write, Edit, Read, WebFetch, WebSearch, Agent, mcp__*, or * for all"),
      f("When it", select({ contains: "contains text", regex: "matches regex" }, r.matchType, (v) => (r.matchType = v)), "Checked against the command, file path, URL or prompt"),
      f("Text / pattern", matchIn),
      f("Applies to", select(RULE_SCOPES, r.scope, (v) => (r.scope = v))),
    );
    row.append(top, grid);
    return row;
  }));
}

function runRuleTest() {
  const tool = $("testTool").value;
  const text = $("testText").value;
  const isSub = $("testSub").checked;
  const r = rulesDraft.rules.find((x) => clientRuleMatches(x, tool, text, isSub));
  const out = $("testResult");
  out.className = "test-result " + (r ? `act-${r.action}` : "act-none");
  out.textContent = r ? `Matches “${r.name}” → ${RULE_ACTIONS[r.action]}` : "No rule matches → the agent behaves as usual";
}

async function renderRules() {
  const status = $("rulesStatus");
  if (!rulesDraft) {
    try {
      rulesDraft = structuredClone(await flBridge("GET", "/api/rules"));
      status.textContent = rulesDraft.updatedAt ? `Last saved ${flTimeAgo(rulesDraft.updatedAt)}${rulesDraft.updatedBy ? ` by ${rulesDraft.updatedBy}` : ""}` : "Default rules";
    } catch (e) {
      $("ruleRows").replaceChildren(ib("p", "muted", `Can't load rules: ${e.message}. Rules live in the bridge, so it has to be running and paired (Settings → Agent bridge).`));
      return;
    }
  }
  $("ruleTimeout").value = rulesDraft.timeoutSec;
  $("ruleOnTimeout").value = rulesDraft.onTimeout;
  renderRuleRows();
  runRuleTest();
}

function initPermissions() {
  $("permFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    perm.filter = b.dataset.f;
    for (const x of $("permFilter").children) x.classList.toggle("on", x === b);
    render();
  });
  // live countdowns
  setInterval(() => {
    for (const el of document.querySelectorAll(".countdown[data-expires]")) {
      const left = flTimeLeft(Number(el.dataset.expires));
      el.textContent = el.closest(".task-item") ? `${left} left` : left;
    }
  }, 1000);

  $("addRule").addEventListener("click", () => {
    rulesDraft.rules.push({ id: `r-${Date.now().toString(36)}`, name: "New rule", enabled: true, tools: "Bash,PowerShell", match: "", matchType: "contains", scope: "any", action: "ask" });
    renderRuleRows();
    $("ruleRows").lastElementChild?.querySelector(".rule-name")?.select();
  });
  for (const id of ["testTool", "testText", "testSub"]) $(id).addEventListener("input", () => rulesDraft && runRuleTest());
  $("ruleTimeout").addEventListener("input", (e) => (rulesDraft.timeoutSec = Number(e.target.value)));
  $("ruleOnTimeout").addEventListener("change", (e) => (rulesDraft.onTimeout = e.target.value));
  $("saveRules").addEventListener("click", async () => {
    const status = $("rulesStatus");
    try {
      rulesDraft = structuredClone(await flBridge("PUT", "/api/rules", { ...rulesDraft, updatedBy: me.displayName }));
      status.textContent = "Saved ✓ The new rules apply to the next tool call.";
      renderRules();
    } catch (e) {
      status.textContent = `Not saved: ${e.message}`;
    }
  });
  $("reloadRules").addEventListener("click", () => { rulesDraft = null; renderRules(); });
}
