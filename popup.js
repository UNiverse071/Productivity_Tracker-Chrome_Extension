const $ = (id) => document.getElementById(id);

let me = null;

async function render() {
  me = await flCurrentUser();
  if (!me) return location.reload(); // signed out elsewhere
  globalThis.FL_UID = me.id;
  const settings = await flGetSettings();
  const prefs = await flGetPrefs(me.id);
  flApplyTheme(prefs.theme);
  const key = flDayKey();
  const day = flNormalizeDay((await chrome.storage.local.get(key))[key]);
  const { live } = await chrome.storage.session.get("live");

  renderHeroUser();

  const liveEl = $("live");
  if (prefs.paused) {
    liveEl.dataset.state = "paused";
    $("liveText").textContent = "Tracking paused";
  } else if (live && live.uid === me.id && Date.now() - live.at < 20000) {
    liveEl.dataset.state = live.state;
    $("liveText").textContent = `${FL_LABELS[live.state]} · ${live.host}${live.generating ? " (AI is responding)" : ""}`;
  } else {
    delete liveEl.dataset.state;
    $("liveText").textContent = "Not tracking right now";
  }

  const t = day.totals;
  const pct = flProductivityPct(t, settings);
  $("unproductive").textContent = flFormatDuration(flUnproductive(t, settings));
  drawDonut($("ring"), FL_STATES.map((s) => ({ cls: s, value: t[s], label: FL_LABELS[s], text: flFormatDuration(t[s]) })), {
    size: 84, thickness: 10, center: pct == null ? "—" : `${pct}%`,
  });
  $("tActive").textContent = flFormatDuration(t.active);
  $("tAi").textContent = flFormatDuration(t.aiWaiting);
  $("tIdle").textContent = flFormatDuration(t.idle);
  $("waits").textContent = day.ai.episodes ? `${flPlural(day.ai.episodes, "AI wait")} · avg ${flFormatDuration(day.ai.totalMs / day.ai.episodes)}` : "";

  drawStackedColumns($("hours"), day.hours.map((b, i) => ({
    label: String(i), bucket: b,
    tip: `${String(i).padStart(2, "0")}:00\n` + FL_STATES.map((s) => `${FL_LABELS[s]}: ${flFormatDuration(b[s])}`).join("\n"),
  })), { height: 110, labelEvery: 6 });

  const sites = Object.entries(day.sites).sort((a, b) => flSum(b[1]) - flSum(a[1])).slice(0, 4);
  const ul = $("sites");
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No activity recorded yet today.";
    ul.replaceChildren(li);
  } else {
    const max = flSum(sites[0][1]);
    ul.replaceChildren(...sites.map(([host, b]) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.className = "host";
      name.textContent = host;
      if (flMatchesDomain(host, settings.aiDomains)) {
        const tag = document.createElement("span");
        tag.className = "tag ai";
        tag.textContent = "AI";
        name.appendChild(tag);
      }
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = flFormatDuration(flSum(b));
      row.append(name, time);
      const bar = document.createElement("div");
      bar.className = "stack thin";
      bar.style.width = `${(flSum(b) / max) * 100}%`;
      for (const s of FL_STATES) {
        if (!b[s]) continue;
        const seg = document.createElement("span");
        seg.className = `f-${s}`;
        seg.style.width = `${(b[s] / flSum(b)) * 100}%`;
        bar.appendChild(seg);
      }
      bar.dataset.tip = FL_STATES.map((s) => `${FL_LABELS[s]}: ${flFormatDuration(b[s])}`).join("\n");
      li.append(row, bar);
      return li;
    }));
  }

  $("paused").checked = prefs.paused;
  $("pauseRow").hidden = !flCan(me, "pauseTracking");
  $("countIdle").checked = settings.countGeneralIdle;
  $("countIdle").disabled = me.role !== "admin";
  $("idleNote").textContent = me.role === "admin" ? "" : "Set by your admin";
  $("swatches").replaceChildren(...["auto", ...Object.keys(FL_THEMES)].map((id) => {
    const t = FL_THEMES[id] || { name: "Auto (follow system)", g1: "#94a3b8", g2: "#334155" };
    const b = document.createElement("button");
    b.className = "swatch" + (prefs.theme === id ? " on" : "");
    b.style.background = `linear-gradient(135deg, ${t.g1}, ${t.g2})`;
    b.title = t.name;
    b.setAttribute("aria-label", `Theme: ${t.name}`);
    b.addEventListener("click", async () => { await flSavePrefs(me.id, { theme: id }); render(); });
    return b;
  }));

  $("inboxCard").hidden = !flCan(me, "viewAgents");
  if (flCan(me, "viewAgents")) renderInboxMini(settings);
  renderPermMini(settings);
}

function renderHeroUser() {
  const box = $("heroUser");
  const a = document.createElement("span");
  a.className = "avatar small on-band";
  a.textContent = flInitials(me.displayName);
  const name = document.createElement("span");
  name.textContent = me.displayName;
  const out = document.createElement("button");
  out.className = "band-btn";
  out.textContent = "Sign out";
  out.onclick = async () => {
    await flLogout();
    try { chrome.runtime.sendMessage({ type: "authChanged" }); } catch {}
    location.reload();
  };
  box.replaceChildren(a, name, out);
}

// Pending permission requests, answerable right here.
async function renderPermMini(settings) {
  const card = $("permCard");
  const can = flCan(me, "approvePermissions");
  if (!(settings.bridgeToken || globalThis.FL_DEMO_BRIDGE) || !(can || flCan(me, "viewAgents"))) { card.hidden = true; return; }
  const { cache } = await flSyncPermissions();
  const pending = Object.values(cache.items).filter((p) => flPermBucket(p) === "pending").sort((a, b) => a.createdAt - b.createdAt);
  card.hidden = !pending.length;
  if (!pending.length) return;
  $("permSummary").textContent = `${pending.length} waiting`;
  const box = $("permMini");
  if (box.contains(document.activeElement)) return; // don't redraw under the cursor
  box.replaceChildren(...pending.slice(0, 3).map((p) => {
    const row = document.createElement("div");
    row.className = "mini-perm";
    const top = document.createElement("div");
    top.className = "mini-perm-top";
    const what = document.createElement("b");
    what.textContent = `${p.agent} → ${p.toolName}`;
    const left = document.createElement("span");
    left.className = "muted";
    left.textContent = `${flTimeLeft(p.expiresAt)} left`;
    top.append(what, left);
    const cmd = document.createElement("code");
    cmd.className = "mini-cmd";
    cmd.textContent = (p.summary || "").split("\n")[0].slice(0, 120);
    cmd.title = p.summary || "";
    const rule = document.createElement("small");
    rule.className = "muted";
    rule.textContent = `Rule: ${p.ruleName}`;
    row.append(top, cmd, rule);
    if (can) {
      const btns = document.createElement("div");
      btns.className = "mini-perm-btns";
      const ok = document.createElement("button");
      ok.className = "primary approve small";
      ok.textContent = "Approve";
      const no = document.createElement("button");
      no.className = "ghost danger small";
      no.textContent = "Deny";
      const more = document.createElement("a");
      more.href = "#";
      more.className = "link";
      more.textContent = "Details";
      more.onclick = (e) => { e.preventDefault(); openDashboard(`#permissions/${encodeURIComponent(p.id)}`); };
      const go = async (d) => {
        ok.disabled = no.disabled = true;
        try { await flDecidePermission(p.id, d, "", me); } catch (e) { rule.textContent = e.message; }
        render();
      };
      ok.onclick = () => go("allow");
      no.onclick = () => go("deny");
      btns.append(ok, no, more);
      row.append(btns);
    } else {
      const note = document.createElement("small");
      note.className = "muted";
      note.textContent = "Waiting for someone who's allowed to approve it.";
      row.append(note);
    }
    return row;
  }));
}

function openDashboard(hash = "") {
  if (globalThis.FL_DEMO) location.href = `dashboard.html${hash}`;
  else chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
}

// The three most recent sub-agent tasks, newest first.
async function renderInboxMini(settings) {
  const box = $("inboxMini");
  const { cache } = settings.bridgeToken || globalThis.FL_DEMO_BRIDGE ? await flSyncAgentTasks() : { cache: await flGetAgentCache() };
  const tasks = Object.values(cache.tasks).filter((t) => !t.archived);
  const c = flAgentCounts(cache.tasks);
  $("inboxSummary").textContent = tasks.length ? `${c.running} running · ${c.review} to review` : "";
  if (!tasks.length) {
    const p = document.createElement("p");
    p.className = "muted small-note";
    p.textContent = settings.bridgeToken || globalThis.FL_DEMO_BRIDGE
      ? (cache.ok ? "No sub-agent tasks yet." : "The bridge isn't running. Start it with node bridge/server.mjs.")
      : "Connect your agents to see their sub-agent tasks here.";
    const a = document.createElement("a");
    a.href = "#";
    a.className = "link";
    a.textContent = settings.bridgeToken ? "Open the inbox →" : "Set up →";
    a.onclick = (e) => { e.preventDefault(); openDashboard(settings.bridgeToken ? "#inbox" : "#settings"); };
    box.replaceChildren(p, a);
    return;
  }
  const latest = tasks.sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0)).slice(0, 3);
  box.replaceChildren(...latest.map((t) => {
    const a = document.createElement("a");
    a.href = "#";
    a.className = "mini-task" + (!t.read && t.status !== "running" ? " unread" : "");
    const b = flTaskBucket(t);
    const dot = document.createElement("span");
    dot.className = `mini-dot st-${b === "review" && t.status === "failed" ? "failed" : b}`;
    const title = document.createElement("span");
    title.className = "mini-title";
    title.textContent = t.title;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = t.status === "running" ? "running" : flTimeAgo(t.endedAt || t.startedAt);
    a.append(dot, title, meta);
    a.title = `${t.agent || "subagent"} · ${t.status}`;
    a.onclick = (e) => { e.preventDefault(); openDashboard(`#inbox/${encodeURIComponent(t.id)}`); };
    return a;
  }));
}

$("paused").addEventListener("change", async (e) => {
  if (flCan(me, "pauseTracking")) await flSavePrefs(me.id, { paused: e.target.checked });
  render();
});
$("countIdle").addEventListener("change", async (e) => {
  if (me.role === "admin") await flSaveSettings({ countGeneralIdle: e.target.checked });
  render();
});
$("openDash").addEventListener("click", () => openDashboard());

(async () => {
  const { lastUser } = await chrome.storage.local.get("lastUser");
  const last = Object.values(await flGetUsers()).find((u) => u.username === lastUser);
  flApplyTheme(last ? (await flGetPrefs(last.id)).theme : "auto");
  me = await flAuthGate($("authGate"));
  try { chrome.runtime.sendMessage({ type: "authChanged" }); } catch {}
  await render();
  setInterval(render, 2000);
})();
