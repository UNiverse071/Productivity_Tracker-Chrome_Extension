// Background service worker: receives heartbeats from content scripts, makes
// sure they come from the tab you're actually using, and accumulates time for
// the signed-in user. It also watches the agent bridge for finished sub-agent
// tasks and new permission requests, and raises notifications for them.
//
// Data lives in chrome.storage.local (this Chrome profile only, never synced).
// Each user's days are separate records ("day:<userId>:YYYY-MM-DD"), and a time
// slice that crosses an hour or midnight is split so it lands in the right
// buckets. Nothing is recorded while nobody is signed in.

importScripts("shared.js", "auth.js", "agents.js");

const BADGE_COLORS = { active: "#199e70", aiWaiting: "#d95926", idle: "#3987e5" };
const LIVE_STALE_MS = 20000;
const SEGMENT_GAP_MS = 12000; // heartbeats closer than this extend the same timeline segment
const MAX_SEGMENTS = 4000;

// Serialize storage read-modify-write so overlapping messages can't clobber each other.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error("[Focus Ledger]", e));
  return queue;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "heartbeat") enqueue(() => record(msg, sender));
  if (msg?.type === "authChanged") enqueue(async () => {
    await chrome.storage.session.remove(["live", "episode"]);
    await refreshBadge();
    pollBridge();
  });
  return false;
});

// ---- day store ------------------------------------------------------------

async function loadDays(keys) {
  const got = await chrome.storage.local.get(keys);
  const days = {};
  for (const k of keys) days[k] = flNormalizeDay(got[k]);
  return days;
}

// Split [start, end) at hour boundaries so each piece belongs to exactly one
// day and one hour.
function splitByHour(start, end) {
  const pieces = [];
  let t = start;
  while (t < end) {
    const d = new Date(t);
    d.setMinutes(60, 0, 0); // next hour boundary (local time)
    const stop = Math.min(end, d.getTime());
    pieces.push([t, stop]);
    t = stop;
  }
  return pieces;
}

function addSegment(day, start, end, stateIdx, host) {
  const last = day.segments[day.segments.length - 1];
  if (last && last[2] === stateIdx && last[3] === host && start - last[1] <= SEGMENT_GAP_MS) {
    last[1] = Math.max(last[1], end);
  } else {
    day.segments.push([start, end, stateIdx, host]);
    if (day.segments.length > MAX_SEGMENTS) day.segments.splice(0, day.segments.length - MAX_SEGMENTS);
  }
}

function binIndex(ms) {
  const s = ms / 1000;
  return FL_WAIT_BINS.findIndex((b) => s < b);
}

// An "episode" = one continuous stretch of waiting on an AI, from the first
// waiting heartbeat until any non-waiting heartbeat. It's credited to the day
// it ended, for the user who was signed in.
async function closeEpisode(days) {
  const { episode } = await chrome.storage.session.get("episode");
  if (!episode || episode.ms < 1000 || !episode.uid) {
    if (episode) await chrome.storage.session.remove("episode");
    return;
  }
  const key = flDayKey(episode.lastAt, episode.uid);
  if (!days[key]) Object.assign(days, await loadDays([key]));
  const ai = days[key].ai;
  ai.episodes += 1;
  ai.totalMs += episode.ms;
  ai.longestMs = Math.max(ai.longestMs, episode.ms);
  ai.bins[binIndex(episode.ms)] += 1;
  const site = (ai.bySite[episode.host] ||= { episodes: 0, ms: 0 });
  site.episodes += 1;
  site.ms += episode.ms;
  await chrome.storage.session.remove("episode");
}

// ---- heartbeat ------------------------------------------------------------

async function record(msg, sender) {
  const tab = sender.tab;
  if (!tab || !tab.active || !FL_STATES.includes(msg.state)) return;

  const user = await flCurrentUser();
  if (!user) return; // nobody signed in: record nothing
  const prefs = await flGetPrefs(user.id);
  if (prefs.paused) return;
  const settings = await flGetSettings();

  // Double-check: the tab must be the active one in the focused window,
  // and the machine must not be locked.
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win || !win.focused) return;
  if ((await chrome.idle.queryState(60)) === "locked") return;

  const delta = Math.max(0, Math.min(Number(msg.delta) || 0, 15000));
  if (!delta) return;

  const end = Date.now();
  const start = end - delta;
  const host = String(msg.host || "unknown").slice(0, 200);
  const stateIdx = FL_STATES.indexOf(msg.state);

  const pieces = splitByHour(start, end);
  const keys = [...new Set(pieces.map(([s]) => flDayKey(s, user.id)))];
  const days = await loadDays(keys);

  for (const [s, e] of pieces) {
    const day = days[flDayKey(s, user.id)];
    const ms = e - s;
    day.totals[msg.state] += ms;
    (day.sites[host] ||= flEmptyBucket())[msg.state] += ms;
    day.hours[new Date(s).getHours()][msg.state] += ms;
    addSegment(day, s, e, stateIdx, host);
  }

  // AI wait episodes
  if (msg.state === "aiWaiting") {
    const { episode } = await chrome.storage.session.get("episode");
    const ep = episode && episode.host === host && episode.uid === user.id ? episode : null;
    if (episode && !ep) await closeEpisode(days); // switched site (or user)
    await chrome.storage.session.set({
      episode: { uid: user.id, host, ms: (ep?.ms || 0) + delta, lastAt: end },
    });
  } else {
    await closeEpisode(days);
  }

  await chrome.storage.local.set(days);
  await chrome.storage.session.set({
    live: { uid: user.id, state: msg.state, host, generating: !!msg.generating, isAI: !!msg.isAI, at: end },
  });
  await setBadge(msg.state, days[flDayKey(end, user.id)], settings);
}

async function setBadge(state, day, settings) {
  const unprod = flUnproductive(day.totals, settings);
  const mins = Math.floor(unprod / 60000);
  await chrome.action.setBadgeText({ text: mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m` });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[state] });
  await chrome.action.setTitle({
    title: `Focus Ledger — ${FL_LABELS[state]}\nUnproductive today: ${flFormatDuration(unprod)}`,
  });
}

// Badge when there's no live heartbeat: signed out, paused, or idle.
async function refreshBadge() {
  const user = await flCurrentUser();
  const pending = (await flGetPermCache()).pendingCount || 0;
  if (!user) {
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setTitle({ title: "Focus Ledger — signed out. Click to sign in." });
    return;
  }
  if (pending && flCan(user, "approvePermissions")) {
    await chrome.action.setBadgeText({ text: `!${pending}` });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setTitle({ title: `Focus Ledger — ${flPlural(pending, "permission request")} waiting for you` });
    return;
  }
  if ((await flGetPrefs(user.id)).paused) {
    await chrome.action.setBadgeText({ text: "II" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setTitle({ title: `Focus Ledger — ${user.displayName} · paused` });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: `Focus Ledger — ${user.displayName}` });
}

async function clearLive() {
  await chrome.storage.session.remove("live");
  await refreshBadge();
}

async function pruneOldDays() {
  const { retentionDays } = await flGetSettings();
  const cutoff = flDateStr(Date.now() - retentionDays * 86400000);
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith("day:") && k.slice(k.lastIndexOf(":") + 1) < cutoff);
  if (old.length) await chrome.storage.local.remove(old);
}

async function countSwitch() {
  const user = await flCurrentUser();
  if (!user || (await flGetPrefs(user.id)).paused) return;
  const key = flDayKey(Date.now(), user.id);
  const days = await loadDays([key]);
  days[key].switches += 1;
  await chrome.storage.local.set(days);
}

// closeEpisode() mutates the passed-in days object; persist whatever it touched.
async function closeEpisodeAndSave() {
  const days = {};
  await closeEpisode(days);
  if (Object.keys(days).length) await chrome.storage.local.set(days);
}

// ---- events ---------------------------------------------------------------

chrome.tabs.onActivated.addListener(() => enqueue(countSwitch));

chrome.windows.onFocusChanged.addListener((id) => {
  if (id === chrome.windows.WINDOW_ID_NONE) {
    enqueue(async () => {
      await closeEpisodeAndSave();
      await clearLive();
    });
  } else {
    enqueue(countSwitch);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((k) => k.startsWith("prefs:"))) enqueue(clearLive);
  if (changes.settings) pollBridge();
});

chrome.alarms.onAlarm.addListener((a) => {
  // Clear the live status when nothing has reported recently (browser
  // minimized, tab switched to a page without the content script...).
  if (a.name === "stale") enqueue(async () => {
    const { live } = await chrome.storage.session.get("live");
    if (live && Date.now() - live.at > LIVE_STALE_MS) {
      await closeEpisodeAndSave();
      await clearLive();
    }
  });
  if (a.name === "prune") enqueue(pruneOldDays);
  if (a.name === "agents") pollBridge();
});

function ensureAlarms() {
  chrome.alarms.create("stale", { periodInMinutes: 0.5 });
  chrome.alarms.create("prune", { periodInMinutes: 360 });
  chrome.alarms.create("agents", { periodInMinutes: 0.5 });
}

// ---- agent bridge: tasks + permission requests --------------------------------

// Long-poll the bridge's change feed so new permission requests notify within
// a second or two (an agent is blocked until someone answers). Each loop turn
// touches extension storage, which keeps this service worker alive while
// signed in; the "agents" alarm restarts the loop if Chrome stops it.
let polling = false;
async function pollBridge() {
  if (polling) return;
  polling = true;
  try {
    let version = 0;
    for (let i = 0; i < 500; i++) {
      const settings = await flGetSettings();
      const user = await flCurrentUser();
      if (!settings.bridgeToken || !user) break;
      let changed;
      try {
        changed = await flBridge("GET", `/api/changes?since=${version}&timeout=20`, undefined, 30000);
      } catch {
        break; // bridge offline; the alarm retries in 30 s
      }
      if (changed.version !== version) {
        version = changed.version;
        await syncAgents(settings, user);
        await syncPermissions(settings, user);
      }
    }
  } finally {
    polling = false;
  }
}

async function syncAgents(settings, user) {
  const { newlyFinished } = await flSyncAgentTasks();
  if (!settings.notifyAgentTasks || !flCan(user, "viewAgents")) return;
  for (const t of newlyFinished.slice(0, 3)) {
    chrome.notifications.create(`task:${t.id}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: t.status === "failed" ? "Sub-agent task failed" : "Sub-agent task finished",
      message: `${t.title}${t.agent ? ` · ${t.agent}` : ""}`,
      contextMessage: "Click to review it in your Agent inbox",
      priority: 1,
    });
  }
}

async function syncPermissions(settings, user) {
  const { newlyPending, resolved } = await flSyncPermissions();
  for (const p of resolved) chrome.notifications.clear(`perm:${p.id}`);
  if (flCan(user, "approvePermissions")) {
    for (const p of newlyPending.slice(0, 3)) {
      chrome.notifications.create(`perm:${p.id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: `Permission needed: ${p.toolName}`,
        message: (p.summary || "").split("\n")[0].slice(0, 180) || p.ruleName,
        contextMessage: `${p.agent} · rule “${p.ruleName}”`,
        buttons: [{ title: "Approve" }, { title: "Deny" }],
        requireInteraction: true,
        priority: 2,
      });
    }
  }
  await refreshBadge();
}

chrome.notifications.onClicked.addListener((id) => {
  const [kind, ...rest] = id.split(":");
  const target = { task: "inbox", perm: "permissions" }[kind];
  if (!target) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html#${target}/${encodeURIComponent(rest.join(":"))}`) });
  chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  if (!id.startsWith("perm:")) return;
  const user = await flCurrentUser();
  chrome.notifications.clear(id);
  if (!flCan(user, "approvePermissions")) return;
  try {
    await flDecidePermission(id.slice(5), index === 0 ? "allow" : "deny", "", user);
  } catch (e) {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "Couldn't send your answer", message: e.message });
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  enqueue(refreshBadge);
  pollBridge();
});

chrome.runtime.onInstalled.addListener(async () => {
  ensureAlarms();
  enqueue(pruneOldDays);
  enqueue(refreshBadge);
  pollBridge();
  // Content scripts only auto-inject into pages loaded after install, so
  // inject into tabs that are already open.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const t of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: t.id }, files: ["shared.js", "content.js"] })
      .catch(() => {}); // e.g. Chrome Web Store pages can't be scripted
  }
});
