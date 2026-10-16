// Shared by the background worker, content script, popup and dashboard.
// Uses `var`/function declarations so it can be injected twice into a page
// (after an extension reload) without "already declared" errors.

var FL_DEFAULTS = {
  // Seconds without input before you're considered idle.
  idleThresholdSec: 10,
  // If false, plain idle time (not waiting on an AI) is shown but not counted as unproductive.
  countGeneralIdle: true,
  // A prompt you've submitted stops counting as "waiting" after this long if no
  // response is detected (safety cap for sites where detection doesn't work).
  maxWaitSec: 180,
  retentionDays: 30,
  paused: false,
  theme: "auto",
  // Agent inbox: the local bridge (bridge/server.mjs) and its pairing token.
  bridgeUrl: "http://127.0.0.1:47321",
  bridgeToken: "",
  notifyAgentTasks: true,
  aiDomains: [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "aistudio.google.com",
    "copilot.microsoft.com",
    "perplexity.ai",
    "chat.deepseek.com",
    "grok.com",
    "poe.com",
    "chat.mistral.ai",
    "meta.ai",
  ],
};

var FL_STATES = ["active", "aiWaiting", "idle"];
var FL_LABELS = { active: "Productive", aiWaiting: "Waiting on AI", idle: "Idle" };

// Wait-length histogram bins (upper bounds in seconds; last bin is open-ended).
var FL_WAIT_BINS = [10, 30, 60, 120, Infinity];
var FL_WAIT_BIN_LABELS = ["<10s", "10–30s", "30–60s", "1–2m", "2m+"];

// Theme presets, in the spirit of Better Canvas' premade dark-mode themes.
// `mode` picks the light or dark set of data colors so charts stay legible.
var FL_THEMES = {
  daylight: { name: "Daylight", mode: "light", bg: "#f5f6fa", surface: "#ffffff", surface2: "#eef0f5", text: "#141821", muted: "#5d6473", border: "#e2e5ec", g1: "#6366f1", g2: "#06b6d4" },
  midnight: { name: "Midnight", mode: "dark", bg: "#0f1117", surface: "#181b24", surface2: "#222633", text: "#eef0f6", muted: "#9aa1b2", border: "#2b3040", g1: "#7c3aed", g2: "#2563eb" },
  ocean:    { name: "Ocean",    mode: "dark", bg: "#0b1a26", surface: "#10263a", surface2: "#16324b", text: "#e6f3fb", muted: "#93b3c8", border: "#1f405b", g1: "#0ea5e9", g2: "#14b8a6" },
  sunset:   { name: "Sunset",   mode: "light", bg: "#fff6ef", surface: "#ffffff", surface2: "#ffeadb", text: "#2a1710", muted: "#7a5546", border: "#f6d9c6", g1: "#f43f5e", g2: "#f59e0b" },
  forest:   { name: "Forest",   mode: "dark", bg: "#0e1612", surface: "#15211b", surface2: "#1c2c24", text: "#e8f3ec", muted: "#9db5a6", border: "#26392f", g1: "#16a34a", g2: "#84cc16" },
  candy:    { name: "Candy",    mode: "light", bg: "#fbf5ff", surface: "#ffffff", surface2: "#f3e8ff", text: "#1f1430", muted: "#6b5a80", border: "#eadcf8", g1: "#d946ef", g2: "#8b5cf6" },
};

function flResolveTheme(id) {
  if (FL_THEMES[id]) return FL_THEMES[id];
  const dark = globalThis.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? FL_THEMES.midnight : FL_THEMES.daylight;
}

function flApplyTheme(id) {
  const t = flResolveTheme(id);
  const root = document.documentElement;
  root.dataset.mode = t.mode;
  root.style.colorScheme = t.mode;
  for (const k of ["bg", "surface", "surface2", "text", "muted", "border", "g1", "g2"]) {
    root.style.setProperty(`--${k}`, t[k]);
  }
}

async function flGetSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...FL_DEFAULTS, ...(settings || {}) };
}

async function flSaveSettings(patch) {
  const s = await flGetSettings();
  const next = { ...s, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function flDateStr(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Each user's days are stored separately: "day:<userId>:YYYY-MM-DD".
// Pages set globalThis.FL_UID to the user whose data they show.
function flDayKey(ts = Date.now(), uid = globalThis.FL_UID) {
  if (!uid) throw new Error("flDayKey: no user");
  return `day:${uid}:${flDateStr(ts)}`;
}

function flMatchesDomain(host, domains) {
  host = (host || "").toLowerCase();
  return domains.some((d) => {
    d = d.trim().toLowerCase();
    return d && (host === d || host.endsWith("." + d));
  });
}

function flEmptyBucket() {
  return { active: 0, aiWaiting: 0, idle: 0 };
}

function flEmptyDay() {
  return {
    v: 2,
    totals: flEmptyBucket(),
    sites: {},
    hours: Array.from({ length: 24 }, flEmptyBucket),
    // [startMs, endMs, stateIndex, host] — merged runs of the same state+site.
    segments: [],
    ai: { episodes: 0, totalMs: 0, longestMs: 0, bins: FL_WAIT_BINS.map(() => 0), bySite: {} },
    switches: 0,
  };
}

// Fill in fields missing from days recorded by older versions.
function flNormalizeDay(d) {
  const e = flEmptyDay();
  if (!d) return e;
  return { ...e, ...d, ai: { ...e.ai, ...(d.ai || {}) } };
}

function flSum(b) {
  return b.active + b.aiWaiting + b.idle;
}

function flUnproductive(bucket, settings) {
  return bucket.aiWaiting + (settings.countGeneralIdle ? bucket.idle : 0);
}

function flProductivityPct(bucket, settings) {
  const u = flUnproductive(bucket, settings);
  return bucket.active + u ? Math.round((bucket.active / (bucket.active + u)) * 100) : null;
}

function flFormatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function flPlural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
