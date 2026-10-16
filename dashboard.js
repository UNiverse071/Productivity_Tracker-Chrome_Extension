const $ = (id) => document.getElementById(id);

const VIEWS = {
  overview: ["Overview", "A summary of the selected day"],
  hours: ["By hour", "When during the day you worked, waited and sat idle"],
  ai: ["AI waiting", "Time spent waiting on AI chatbots to respond"],
  sites: ["Sites", "Time on each website"],
  trends: ["Trends", "How your days compare"],
  inbox: ["Agent inbox", "Tasks your agents handed to sub-agents. Review them and request changes"],
  permissions: ["Permission requests", "Agents waiting for your OK before doing something your rules cover"],
  rules: ["Permission rules", "Decide what agents must ask permission for"],
  users: ["Users", "Accounts and what each person may do"],
  settings: ["Settings", "Your account, theme, tracking and the agent bridge"],
  about: ["About the stats", "What each number means"],
};
const DAY_VIEWS = new Set(["overview", "hours", "ai", "sites"]);

let settings = { ...FL_DEFAULTS };
let selected = startOfDay(Date.now());
let trendRange = 7;
let siteFilter = "all";

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function shiftDay(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function isAIHost(h) {
  return flMatchesDomain(h, settings.aiDomains);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function bucketTip(label, b) {
  return `${label}\n` + FL_STATES.map((s) => `${FL_LABELS[s]}: ${flFormatDuration(b[s])}`).join("\n");
}

// ---- shared pieces -------------------------------------------------------------

function kpi(label, value, sub, cls) {
  const c = el("div", `kpi ${cls || ""}`);
  c.append(el("div", "kpi-label", label), el("div", "kpi-value", value));
  if (sub) c.append(el("div", "kpi-sub", sub));
  return c;
}

function fillLegends() {
  for (const ul of document.querySelectorAll("[data-legend]")) {
    ul.replaceChildren(...FL_STATES.map((s) => {
      const li = el("li");
      li.append(el("span", `sw f-${s}`), document.createTextNode(FL_LABELS[s]));
      return li;
    }));
  }
}

function stackBar(b) {
  const bar = el("div", "stack");
  const total = flSum(b) || 1;
  for (const s of FL_STATES) {
    if (!b[s]) continue;
    const seg = el("span", `f-${s}`);
    seg.style.width = `${(b[s] / total) * 100}%`;
    bar.append(seg);
  }
  bar.dataset.tip = bucketTip("", b).trim();
  return bar;
}

function table(tableEl, head, rows) {
  const thead = el("thead");
  const tr = el("tr");
  head.forEach((h) => tr.append(el("th", null, h)));
  thead.append(tr);
  const tbody = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    for (const c of r) {
      const td = el("td");
      if (c instanceof Node) td.append(c);
      else td.textContent = c;
      row.append(td);
    }
    tbody.append(row);
  }
  if (!rows.length) {
    const row = el("tr");
    const td = el("td", "muted", "No data for this day yet.");
    td.colSpan = head.length;
    row.append(td);
    tbody.append(row);
  }
  tableEl.replaceChildren(thead, tbody);
}

// ---- views --------------------------------------------------------------------

function renderOverview(day) {
  const t = day.totals;
  const unprod = flUnproductive(t, settings);
  const pct = flProductivityPct(t, settings);
  $("kpis").replaceChildren(
    kpi("Productive", flFormatDuration(t.active), "typing, clicking, scrolling", "g-active"),
    kpi("Waiting on AI", flFormatDuration(t.aiWaiting), flPlural(day.ai.episodes, "wait"), "g-aiWaiting"),
    kpi("Idle", flFormatDuration(t.idle), settings.countGeneralIdle ? "counts as unproductive" : "not counted", "g-idle"),
    kpi("Unproductive", flFormatDuration(unprod), "waiting" + (settings.countGeneralIdle ? " + idle" : ""), "g-unprod"),
    kpi("Productivity score", pct == null ? "—" : `${pct}%`, "productive share", "g-brand"),
    kpi("Tab switches", String(day.switches), "context changes", "g-switch"),
  );

  const total = flSum(t);
  drawDonut($("donut"), FL_STATES.map((s) => ({ cls: s, value: t[s], label: FL_LABELS[s], text: flFormatDuration(t[s]) })), {
    size: 180, thickness: 24, center: flFormatDuration(total), sub: "tracked",
  });
  $("donutLegend").replaceChildren(...FL_STATES.map((s) => {
    const li = el("li");
    li.append(el("span", `sw f-${s}`), el("span", null, FL_LABELS[s]),
      el("b", null, flFormatDuration(t[s])), el("span", "muted pct", total ? `${Math.round((t[s] / total) * 100)}%` : "0%"));
    return li;
  }));

  // highlights
  const hl = [];
  const sites = Object.entries(day.sites).sort((a, b) => flSum(b[1]) - flSum(a[1]));
  if (sites[0]) hl.push(["Most-used site", `${sites[0][0]} · ${flFormatDuration(flSum(sites[0][1]))}`]);
  const aiSites = Object.entries(day.ai.bySite).sort((a, b) => b[1].ms - a[1].ms);
  if (aiSites[0]) hl.push(["Most waiting on", `${aiSites[0][0]} · ${flFormatDuration(aiSites[0][1].ms)}`]);
  if (day.ai.episodes) hl.push(["Average AI wait", flFormatDuration(day.ai.totalMs / day.ai.episodes)]);
  const longestActive = day.segments.filter((s) => s[2] === 0).reduce((m, s) => Math.max(m, s[1] - s[0]), 0);
  if (longestActive) hl.push(["Longest focused stretch", flFormatDuration(longestActive)]);
  const firstSeg = day.segments[0], lastSeg = day.segments[day.segments.length - 1];
  if (firstSeg) {
    const f = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    hl.push(["First / last activity", `${f(firstSeg[0])} – ${f(lastSeg[1])}`]);
  }
  if (!hl.length) hl.push(["Nothing yet", "Browse normally and check back. Stats appear within a few seconds."]);
  $("highlights").replaceChildren(...hl.map(([k, v]) => {
    const li = el("li");
    li.append(el("span", "muted", k), el("b", null, v));
    return li;
  }));

  // timeline: zoom to active hours (with padding) so it's readable
  let from = 0, to = 24;
  if (day.segments.length) {
    from = Math.max(0, new Date(day.segments[0][0]).getHours() - 1);
    to = Math.min(24, new Date(day.segments[day.segments.length - 1][1]).getHours() + 2);
  }
  drawTimeline($("timeline"), day.segments, selected, { fromHour: from, toHour: to });
}

function renderHours(day) {
  drawStackedColumns($("hourChart"), day.hours.map((b, i) => ({
    label: String(i).padStart(2, "0"), bucket: b, tip: bucketTip(`${String(i).padStart(2, "0")}:00 – ${String(i + 1).padStart(2, "0")}:00`, b),
  })), { height: 220, labelEvery: 2 });

  const best = day.hours.map((b, i) => [i, b.active]).sort((a, b) => b[1] - a[1])[0];
  const worst = day.hours.map((b, i) => [i, flUnproductive(b, settings)]).sort((a, b) => b[1] - a[1])[0];
  const hr = (i) => `${String(i).padStart(2, "0")}:00 – ${String(i + 1).padStart(2, "0")}:00`;
  const line = (target, [i, v], cls, what) => {
    target.replaceChildren();
    if (!v) { target.append(el("span", "muted", "No data yet")); return; }
    target.append(el("span", `pill f-${cls}`, hr(i)), el("b", null, flFormatDuration(v)), el("span", "muted", what));
  };
  line($("bestHour"), best, "active", "productive");
  line($("worstHour"), worst, "aiWaiting", "unproductive");

  table($("hourTable"), ["Hour", "Productive", "Waiting on AI", "Idle"],
    day.hours.map((b, i) => [hr(i), b.active, b.aiWaiting, b.idle]).filter((r) => r[1] + r[2] + r[3] > 0)
      .map((r) => [r[0], ...r.slice(1).map(flFormatDuration)]));
}

function renderAI(day) {
  const ai = day.ai;
  const aiTotals = flEmptyBucket();
  for (const [h, b] of Object.entries(day.sites)) {
    if (isAIHost(h)) for (const s of FL_STATES) aiTotals[s] += b[s];
  }
  const aiAll = flSum(aiTotals);
  $("aiKpis").replaceChildren(
    kpi("Total waiting", flFormatDuration(day.totals.aiWaiting), "on AI sites", "g-aiWaiting"),
    kpi("Waits", String(ai.episodes), ai.episodes === 1 ? "separate wait" : "separate waits", "g-brand"),
    kpi("Average wait", ai.episodes ? flFormatDuration(ai.totalMs / ai.episodes) : "—", "per wait", "g-switch"),
    kpi("Longest wait", ai.longestMs ? flFormatDuration(ai.longestMs) : "—", "single wait", "g-unprod"),
    kpi("Share of AI time spent waiting", aiAll ? `${Math.round((aiTotals.aiWaiting / aiAll) * 100)}%` : "—", `of ${flFormatDuration(aiAll)} on AI sites`, "g-idle"),
  );

  drawColumns($("waitHist"), FL_WAIT_BIN_LABELS.map((label, i) => ({
    label, value: ai.bins[i] || 0, tip: `${label}: ${flPlural(ai.bins[i] || 0, "wait")}`,
  })), { height: 190 });

  const rows = Object.entries(ai.bySite).sort((a, b) => b[1].ms - a[1].ms)
    .map(([h, v]) => ({ label: h, value: v.ms, tip: `${h}: ${flFormatDuration(v.ms)} over ${flPlural(v.episodes, "wait")}` }));
  if (rows.length) drawHBars($("aiSites"), rows);
  else $("aiSites").replaceChildren(el("p", "muted", "No AI waits recorded for this day."));

  const aiSites = Object.entries(day.sites).filter(([h]) => isAIHost(h)).sort((a, b) => flSum(b[1]) - flSum(a[1]));
  table($("aiTable"), ["AI site", "Working", "Waiting", "Idle", "Waits", "Split"], aiSites.map(([h, b]) => [
    h, flFormatDuration(b.active), flFormatDuration(b.aiWaiting), flFormatDuration(b.idle),
    String(ai.bySite[h]?.episodes || 0), stackBar(b),
  ]));
}

function renderSites(day) {
  let entries = Object.entries(day.sites).sort((a, b) => flSum(b[1]) - flSum(a[1]));
  if (siteFilter === "ai") entries = entries.filter(([h]) => isAIHost(h));
  if (siteFilter === "web") entries = entries.filter(([h]) => !isAIHost(h));
  const total = flSum(day.totals) || 1;
  table($("siteTable"), ["Site", "Type", "Productive", "Waiting on AI", "Idle", "Total", "Share of day", "Split"], entries.map(([h, b]) => {
    const tag = el("span", isAIHost(h) ? "tag ai" : "tag", isAIHost(h) ? "AI" : "Web");
    const share = el("span", "share");
    const fill = el("span");
    fill.style.width = `${(flSum(b) / total) * 100}%`;
    share.append(fill);
    share.dataset.tip = `${Math.round((flSum(b) / total) * 100)}% of tracked time`;
    return [h, tag, flFormatDuration(b.active), flFormatDuration(b.aiWaiting), flFormatDuration(b.idle), flFormatDuration(flSum(b)), share, stackBar(b)];
  }));
}

async function renderTrends() {
  const keys = [];
  for (let i = trendRange - 1; i >= 0; i--) keys.push(shiftDay(startOfDay(Date.now()), -i));
  const got = await chrome.storage.local.get(keys.map((ts) => flDayKey(ts)));
  const days = keys.map((ts) => ({ ts, day: flNormalizeDay(got[flDayKey(ts)]) }));
  const lab = (ts) => new Date(ts).toLocaleDateString(undefined, trendRange > 7 ? { month: "numeric", day: "numeric" } : { weekday: "short" });
  const full = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  drawStackedColumns($("trendChart"), days.map(({ ts, day }) => ({
    label: lab(ts), bucket: day.totals, tip: bucketTip(full(ts), day.totals),
  })), { height: 220, labelEvery: trendRange > 14 ? 3 : 1 });

  drawPercentLine($("pctChart"), days.map(({ ts, day }) => {
    const p = flProductivityPct(day.totals, settings);
    return { label: lab(ts), value: p, tip: `${full(ts)}: ${p == null ? "no data" : p + "%"}` };
  }), { height: 170 });

  const sum = flEmptyBucket();
  let waits = 0, tracked = 0;
  for (const { day } of days) {
    for (const s of FL_STATES) sum[s] += day.totals[s];
    waits += day.ai.episodes;
    if (flSum(day.totals)) tracked++;
  }
  const pct = flProductivityPct(sum, settings);
  $("trendKpis").replaceChildren(
    kpi(`Productive (${trendRange}d)`, flFormatDuration(sum.active), tracked ? `${flFormatDuration(sum.active / tracked)} per active day` : "", "g-active"),
    kpi(`Waiting on AI (${trendRange}d)`, flFormatDuration(sum.aiWaiting), flPlural(waits, "wait"), "g-aiWaiting"),
    kpi(`Idle (${trendRange}d)`, flFormatDuration(sum.idle), "", "g-idle"),
    kpi("Average score", pct == null ? "—" : `${pct}%`, flPlural(tracked, "day") + " with data", "g-brand"),
  );
}

function renderSettings() {
  const wrap = $("themes");
  const opts = [["auto", { name: "Auto", g1: "#6366f1", g2: "#0f1117", bg: "#f5f6fa", surface: "#181b24" }], ...Object.entries(FL_THEMES)];
  wrap.replaceChildren(...opts.map(([id, t]) => {
    const b = el("button", "theme" + (prefs.theme === id ? " on" : ""));
    const prev = el("span", "theme-prev");
    prev.style.background = `linear-gradient(135deg, ${t.g1}, ${t.g2})`;
    const inner = el("span", "theme-inner");
    inner.style.background = id === "auto" ? `linear-gradient(90deg, ${t.bg} 50%, ${t.surface} 50%)` : t.surface;
    prev.append(inner);
    b.append(prev, el("span", null, t.name));
    b.addEventListener("click", async () => {
      prefs = await flSavePrefs(me.id, { theme: id });
      flApplyTheme(id);
      renderSettings();
    });
    return b;
  }));
  for (const f of ["idleThresholdSec", "maxWaitSec", "retentionDays"]) $(f).value = settings[f];
  $("paused").checked = prefs.paused;
  $("paused").disabled = !flCan(me, "pauseTracking");
  $("countGeneralIdle").checked = settings.countGeneralIdle;
  $("aiDomains").value = settings.aiDomains.join("\n");
  $("bridgeUrl").value = settings.bridgeUrl;
  $("bridgeToken").value = settings.bridgeToken;
  $("notifyAgentTasks").checked = settings.notifyAgentTasks;
  // members can see, but not change, the admin's tracking settings
  for (const e of document.querySelectorAll(".admin-lock input, .admin-lock select")) e.disabled = me.role !== "admin";
  renderMyAccount();
}

// ---- access control ------------------------------------------------------------------

function canSee(view) {
  if (view === "inbox") return flCan(me, "viewAgents");
  if (view === "permissions") return flCan(me, "approvePermissions") || flCan(me, "viewAgents");
  if (view === "rules" || view === "users") return me.role === "admin";
  return true;
}

function applyRole() {
  document.documentElement.dataset.role = me.role;
  for (const a of document.querySelectorAll("#nav a")) a.hidden = !canSee(a.dataset.view);
}

function renderUserChip() {
  const chip = $("userChip");
  const names = el("div", "user-names");
  names.append(el("b", null, me.displayName), el("small", "muted", me.role === "admin" ? "Admin" : "Member"));
  const out = el("button", "ghost small", "Sign out");
  out.title = "Sign out (switch user)";
  out.onclick = async () => {
    await flLogout();
    try { chrome.runtime.sendMessage({ type: "authChanged" }); } catch {}
    location.reload();
  };
  chip.replaceChildren(avatar(me), names, out);
}

async function renderViewing() {
  const wrap = $("viewingWrap");
  if (me.role !== "admin") { wrap.hidden = true; return; }
  const users = Object.values(await flGetUsers());
  wrap.hidden = users.length < 2;
  const sel = $("viewingUser");
  if (sel.options.length !== users.length || [...sel.options].some((o, i) => o.value !== users[i]?.id)) {
    sel.replaceChildren(...users.map((u) => {
      const o = el("option", null, u.id === me.id ? `${u.displayName} (you)` : u.displayName);
      o.value = u.id;
      return o;
    }));
  }
  sel.value = viewUid;
}

// ---- routing / refresh ------------------------------------------------------------

function currentView() {
  const v = location.hash.slice(1).split("/")[0];
  return VIEWS[v] && (!me || canSee(v)) ? v : "overview";
}

// "#inbox/<taskId>" -> "<taskId>"
function hashArg() {
  const parts = location.hash.slice(1).split("/");
  return parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : "";
}

async function render() {
  if (!me) return;
  // re-read the account each render: an admin may have changed roles or disabled it
  const fresh = await flCurrentUser();
  if (!fresh) return location.reload();
  me = fresh;
  applyRole();
  if (me.role !== "admin") viewUid = me.id;
  globalThis.FL_UID = viewUid;

  settings = await flGetSettings();
  prefs = await flGetPrefs(me.id);
  flApplyTheme(prefs.theme);
  const view = currentView();
  for (const s of document.querySelectorAll(".view")) s.hidden = s.dataset.view !== view;
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", a.dataset.view === view);
  $("viewTitle").textContent = VIEWS[view][0];
  $("daynav").hidden = !DAY_VIEWS.has(view);
  await renderViewing();
  $("viewingWrap").classList.toggle("hide-here", !DAY_VIEWS.has(view) && view !== "trends");

  const isToday = selected === startOfDay(Date.now());
  const viewedName = viewUid === me.id ? "" : ` · ${(await flGetUsers())[viewUid]?.displayName || ""}`;
  $("viewSub").textContent = DAY_VIEWS.has(view)
    ? `${VIEWS[view][1]} · ${new Date(selected).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${isToday ? " (today)" : ""}${viewedName}`
    : VIEWS[view][1] + (view === "trends" ? viewedName : "");
  const d = new Date(selected);
  $("dayPicker").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("nextDay").disabled = isToday;

  const key = flDayKey(selected);
  const day = flNormalizeDay((await chrome.storage.local.get(key))[key]);
  if (view === "overview") renderOverview(day);
  if (view === "hours") renderHours(day);
  if (view === "ai") renderAI(day);
  if (view === "sites") renderSites(day);
  if (view === "trends") await renderTrends();
  if (view === "settings") renderSettings();
  if (view === "inbox") await renderInbox(hashArg());
  if (view === "permissions") await renderPermissions(hashArg());
  if (view === "rules") await renderRules();
  if (view === "users") await renderUsers();
  if (view !== "inbox" && view !== "permissions") updateNavCount();
  renderLive();
}

async function renderLive() {
  const { live } = await chrome.storage.session.get("live");
  const box = $("live");
  if (prefs.paused) {
    box.dataset.state = "paused";
    $("liveText").textContent = "Tracking paused";
  } else if (live && live.uid === me.id && Date.now() - live.at < 20000) {
    box.dataset.state = live.state;
    $("liveText").textContent = `${FL_LABELS[live.state]} · ${live.host}`;
  } else {
    delete box.dataset.state;
    $("liveText").textContent = "Not tracking right now";
  }
}

// Unread / waiting counts in the sidebar.
async function updateNavCount() {
  const cache = await flGetAgentCache();
  const n = flAgentCounts(cache.tasks).unread;
  $("navCount").hidden = !n;
  $("navCount").textContent = n > 99 ? "99+" : String(n);
  const pc = await flGetPermCache();
  const p = Object.values(pc.items).filter((x) => flPermBucket(x) === "pending").length;
  $("permCount").hidden = !p;
  $("permCount").textContent = String(p);
}

// ---- events -----------------------------------------------------------------------

addEventListener("hashchange", render);
$("viewingUser").addEventListener("change", (e) => { viewUid = e.target.value; render(); });
$("prevDay").addEventListener("click", () => { selected = shiftDay(selected, -1); render(); });
$("nextDay").addEventListener("click", () => { selected = Math.min(startOfDay(Date.now()), shiftDay(selected, 1)); render(); });
$("todayBtn").addEventListener("click", () => { selected = startOfDay(Date.now()); render(); });
$("dayPicker").addEventListener("change", (e) => {
  if (!e.target.value) return;
  const [y, m, d] = e.target.value.split("-").map(Number);
  selected = Math.min(startOfDay(Date.now()), new Date(y, m - 1, d).getTime());
  render();
});
$("siteFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  siteFilter = b.dataset.f;
  for (const x of $("siteFilter").children) x.classList.toggle("on", x === b);
  render();
});
$("rangeSel").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  trendRange = Number(b.dataset.r);
  for (const x of $("rangeSel").children) x.classList.toggle("on", x === b);
  render();
});

function flash() {
  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1500);
}

$("save").addEventListener("click", async () => {
  if (flCan(me, "pauseTracking")) prefs = await flSavePrefs(me.id, { paused: $("paused").checked });
  if (me.role !== "admin") { renderSettings(); flash(); return; }

  const patch = {};
  for (const f of ["idleThresholdSec", "maxWaitSec", "retentionDays"]) {
    const e = $(f);
    const v = Math.round(Number(e.value));
    patch[f] = Math.min(Number(e.max), Math.max(Number(e.min), Number.isFinite(v) ? v : FL_DEFAULTS[f]));
  }
  patch.countGeneralIdle = $("countGeneralIdle").checked;
  patch.aiDomains = $("aiDomains").value.split(/\s+/)
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  const url = $("bridgeUrl").value.trim() || FL_DEFAULTS.bridgeUrl;
  if (!flValidBridgeUrl(url)) {
    $("bridgeTest").textContent = "The bridge address must be http://127.0.0.1:<port> or http://localhost:<port>.";
    return;
  }
  patch.bridgeUrl = url;
  patch.bridgeToken = $("bridgeToken").value.trim();
  patch.notifyAgentTasks = $("notifyAgentTasks").checked;
  const bridgeChanged = patch.bridgeUrl !== settings.bridgeUrl || patch.bridgeToken !== settings.bridgeToken;
  settings = await flSaveSettings(patch);
  if (bridgeChanged) await chrome.storage.local.remove(["agentCache", "permCache"]); // don't mix data from another bridge
  renderSettings();
  flash();
});
$("defaults").addEventListener("click", async () => {
  if (me.role !== "admin") return;
  await chrome.storage.local.remove("settings");
  render();
  flash();
});
$("testBridge").addEventListener("click", async () => {
  const out = $("bridgeTest");
  const url = $("bridgeUrl").value.trim();
  if (!flValidBridgeUrl(url)) { out.textContent = "The address must be on this computer (127.0.0.1 or localhost)."; return; }
  out.textContent = "Testing…";
  const prev = await flGetSettings();
  const token = $("bridgeToken").value.trim();
  if (url !== prev.bridgeUrl || token !== prev.bridgeToken) await chrome.storage.local.remove(["agentCache", "permCache"]);
  settings = await flSaveSettings({ bridgeUrl: url, bridgeToken: token });
  try {
    const h = await flBridge("GET", "/api/health");
    out.textContent = `Connected ✓ · ${flPlural(h.tasks, "task")} · ${flPlural(h.rules ?? 0, "active rule")} · Run now ${h.claudeAvailable ? "available" : "unavailable (Claude Code CLI not found)"}`;
  } catch (e) {
    out.textContent = e instanceof TypeError || e.name === "TimeoutError" ? "Can't reach the bridge. Is node bridge/server.mjs running?" : e.message;
  }
});
// Export only tracked time (yours; admins get everyone's). Never accounts,
// password hashes, sessions or the pairing token.
$("export").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const users = await flGetUsers();
  const out = { exportedBy: me.username, exportedAt: new Date().toISOString(), users: {} };
  for (const u of Object.values(users)) {
    if (me.role !== "admin" && u.id !== me.id) continue;
    const days = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(`day:${u.id}:`)).map(([k, v]) => [k.slice(k.lastIndexOf(":") + 1), v]));
    out.users[u.username] = { displayName: u.displayName, days };
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `focus-ledger-${me.username}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all of your tracked time? Your account and settings are kept.")) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(`day:${me.id}:`)));
  flash();
});

// ---- start: sign in first --------------------------------------------------------

let me = null;
let viewUid = null;
let prefs = { theme: "auto", paused: false };

if (globalThis.FL_DEMO) $("demoBanner").hidden = false;
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => flApplyTheme(prefs.theme));
fillLegends();
initInbox();
initPermissions();
initUsers();
initMyAccount();

(async () => {
  // theme the sign-in screen with the last user's preference
  const { lastUser } = await chrome.storage.local.get("lastUser");
  const last = Object.values(await flGetUsers()).find((u) => u.username === lastUser);
  flApplyTheme(last ? (await flGetPrefs(last.id)).theme : "auto");

  me = await flAuthGate($("authGate"));
  viewUid = me.id;
  try { chrome.runtime.sendMessage({ type: "authChanged" }); } catch {}
  renderUserChip();
  await render();
})();

let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
// Live refresh: the two inboxes every 3 s, other views every 6 s; never on
// Settings, Rules or Users, so nothing you're typing is overwritten.
let tick = 0;
setInterval(() => {
  const v = currentView();
  tick++;
  if (["settings", "rules", "users"].includes(v)) return;
  if (v === "inbox" || v === "permissions" || tick % 2 === 0) render();
}, 3000);
