// Agent inbox: talks to the local Focus Ledger bridge (bridge/server.mjs),
// which collects sub-agent tasks from Claude Code hooks or any other agent
// tool. The last fetched tasks are cached in chrome.storage.local so the
// inbox still shows something while the bridge is offline.

var FL_TASK_STATUS = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

// Only ever talk to a bridge on this machine.
function flValidBridgeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function flBridge(method, pathname, body, timeoutMs = 4000) {
  if (globalThis.FL_DEMO_BRIDGE) return FL_DEMO_BRIDGE(method, pathname, body);
  const s = await flGetSettings();
  if (!flValidBridgeUrl(s.bridgeUrl)) throw new Error("The bridge URL must be on this computer (127.0.0.1 or localhost).");
  if (!s.bridgeToken) throw new Error("Not paired yet. Paste the bridge's pairing token in Settings.");
  const res = await fetch(s.bridgeUrl.replace(/\/$/, "") + pathname, {
    method,
    headers: { "content-type": "application/json", "x-focus-ledger-token": s.bridgeToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("The pairing token doesn't match. Copy it again from the bridge window.");
  if (!res.ok) throw new Error(data.error || `Bridge error ${res.status}`);
  return data;
}

async function flGetAgentCache() {
  const { agentCache } = await chrome.storage.local.get("agentCache");
  return agentCache || { tasks: {}, sessions: {}, lastSync: 0, ok: false, error: "", claudeAvailable: false, notified: {} };
}

// Fetch tasks changed since the last sync and merge them into the cache.
// Returns { cache, newlyFinished: [task] }.
async function flSyncAgentTasks() {
  const cache = await flGetAgentCache();
  const before = cache.tasks;
  try {
    const since = cache.ok ? cache.serverTime || 0 : 0;
    const data = await flBridge("GET", `/api/tasks?since=${since}`);
    const tasks = since ? { ...before } : {};
    for (const t of data.tasks) tasks[t.id] = t;
    Object.assign(cache, {
      tasks, sessions: { ...cache.sessions, ...data.sessions }, serverTime: data.now,
      lastSync: Date.now(), ok: true, error: "", claudeAvailable: !!data.claudeAvailable,
    });
  } catch (e) {
    Object.assign(cache, { ok: false, error: e.name === "TimeoutError" || e instanceof TypeError ? "Bridge not running" : e.message, lastSync: Date.now() });
  }
  const newlyFinished = Object.values(cache.tasks).filter((t) =>
    t.status !== "running" && !t.read && before[t.id]?.status === "running");
  await chrome.storage.local.set({ agentCache: cache });
  return { cache, newlyFinished };
}

// Apply a server response for one task to the cache right away.
async function flCacheTask(task) {
  const cache = await flGetAgentCache();
  cache.tasks[task.id] = task;
  await chrome.storage.local.set({ agentCache: cache });
}

function flTaskBucket(t) {
  if (t.archived) return "archived";
  if (t.status === "running") return "running";
  if (t.review === "accepted") return "done";
  if (t.review === "changes_requested") return "changes";
  return "review"; // completed or failed, waiting for you
}

function flAgentCounts(tasks) {
  const c = { running: 0, review: 0, changes: 0, done: 0, unread: 0 };
  for (const t of Object.values(tasks)) {
    const b = flTaskBucket(t);
    if (b in c) c[b]++;
    if (!t.read && t.status !== "running" && !t.archived) c.unread++;
  }
  return c;
}

// ---- permission requests ----------------------------------------------------------

async function flGetPermCache() {
  const { permCache } = await chrome.storage.local.get("permCache");
  return permCache || { items: {}, serverTime: 0, ok: false, lastSync: 0, pendingCount: 0 };
}

// Returns { cache, newlyPending: [req], resolved: [req] } (resolved = no longer pending).
async function flSyncPermissions() {
  const cache = await flGetPermCache();
  const before = cache.items;
  try {
    const since = cache.ok ? cache.serverTime || 0 : 0;
    const data = await flBridge("GET", `/api/permissions?since=${since}`);
    const items = since ? { ...before } : {};
    for (const p of data.permissions) items[p.id] = p;
    Object.assign(cache, { items, serverTime: data.now, ok: true, lastSync: Date.now(), error: "" });
  } catch (e) {
    Object.assign(cache, { ok: false, lastSync: Date.now(), error: e.name === "TimeoutError" || e instanceof TypeError ? "Bridge not running" : e.message });
  }
  // a pending request whose deadline passed is effectively expired, even before the bridge says so
  const all = Object.values(cache.items);
  cache.pendingCount = all.filter((p) => flPermBucket(p) === "pending").length;
  const newlyPending = all.filter((p) => p.status === "pending" && !before[p.id]);
  const resolved = all.filter((p) => p.status !== "pending" && before[p.id]?.status === "pending");
  await chrome.storage.local.set({ permCache: cache });
  return { cache, newlyPending, resolved };
}

async function flCachePermission(p) {
  const cache = await flGetPermCache();
  cache.items[p.id] = p;
  cache.pendingCount = Object.values(cache.items).filter((x) => flPermBucket(x) === "pending").length;
  await chrome.storage.local.set({ permCache: cache });
}

async function flDecidePermission(id, decision, note, user) {
  const p = await flBridge("POST", `/api/permissions/${encodeURIComponent(id)}/decide`, {
    decision, note, by: user?.displayName || user?.username || "",
  });
  await flCachePermission(p);
  return p;
}

function flPermBucket(p) {
  if (p.archived) return "archived";
  if (p.status === "pending") return p.expiresAt && Date.now() > p.expiresAt ? "expired" : "pending";
  return p.status; // approved | denied | blocked | expired
}

function flTimeLeft(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function flTimeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function flProjectName(cwd) {
  if (!cwd) return "";
  return String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}
