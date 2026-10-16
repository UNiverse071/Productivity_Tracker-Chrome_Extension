// Demo mode. Inside the extension this file does nothing. When popup.html or
// dashboard.html is opened directly (e.g. as a file, for a preview), it
// provides a stand-in `chrome` API filled with two weeks of sample data so
// the UI can be seen working.

(() => {
  if (globalThis.chrome?.storage?.local) return; // real extension: no-op
  globalThis.FL_DEMO = true;

  // deterministic pseudo-random so the demo looks the same each load
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const AI = ["claude.ai", "chatgpt.com", "gemini.google.com"];
  const WEB = ["github.com", "docs.google.com", "stackoverflow.com", "mail.google.com", "youtube.com", "developer.chrome.com"];
  const STATES = ["active", "aiWaiting", "idle"];
  const BINS = [10, 30, 60, 120, Infinity];

  // Demo accounts (password "demo1234" for both); each has its own history.
  const ALEX = "udemoalex0001", SAM = "udemosam00002";
  function key(ts, uid) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `day:${uid}:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function empty() {
    const b = () => ({ active: 0, aiWaiting: 0, idle: 0 });
    return { v: 2, totals: b(), sites: {}, hours: Array.from({ length: 24 }, b), segments: [],
      ai: { episodes: 0, totalMs: 0, longestMs: 0, bins: [0, 0, 0, 0, 0], bySite: {} }, switches: 0 };
  }
  function add(day, s, e, state, host) {
    e = Math.min(e, Date.now() - 60000); // never into the future
    if (e <= s) return;
    const ms = e - s;
    day.totals[state] += ms;
    (day.sites[host] ||= { active: 0, aiWaiting: 0, idle: 0 })[state] += ms;
    day.hours[new Date(s).getHours()][state] += ms;
    day.segments.push([s, e, STATES.indexOf(state), host]);
  }

  function simulate(from, to, day) {
    let t = from;
    let host = pick(WEB);
    while (t < to) {
      // occasionally take a break (gap in tracking)
      if (rand() < 0.06) { t += (5 + rand() * 40) * 60000; host = pick(WEB); continue; }
      if (rand() < 0.35) { host = rand() < 0.5 ? pick(AI) : pick(WEB); day.switches += 1 + Math.floor(rand() * 3); }
      const isAI = AI.includes(host);
      if (isAI) {
        // type a prompt, then wait for the answer, then read it
        const type = (20 + rand() * 90) * 1000;
        const wait = (rand() < 0.15 ? 120 + rand() * 120 : 4 + rand() * 70) * 1000;
        const read = (15 + rand() * 60) * 1000;
        add(day, t, t + type, "active", host); t += type;
        add(day, t, t + wait, "aiWaiting", host); t += wait;
        const ai = day.ai;
        ai.episodes++; ai.totalMs += wait; ai.longestMs = Math.max(ai.longestMs, wait);
        ai.bins[BINS.findIndex((b) => wait / 1000 < b)]++;
        const bs = (ai.bySite[host] ||= { episodes: 0, ms: 0 }); bs.episodes++; bs.ms += wait;
        add(day, t, t + read, "active", host); t += read;
      } else {
        const work = (1 + rand() * 12) * 60000;
        add(day, t, t + work, "active", host); t += work;
        if (rand() < 0.4) {
          const idle = (0.5 + rand() * (host === "youtube.com" ? 15 : 4)) * 60000;
          add(day, t, t + idle, "idle", host); t += idle;
        }
      }
    }
  }

  const store = {};
  const now = Date.now();
  for (const [uid, hoursToday, dayLen] of [[ALEX, 7, 6], [SAM, 4, 4]]) {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const day = empty();
      if (i === 0) {
        simulate(Math.max(d.getTime(), now - hoursToday * 3600000), now - 60000, day);
      } else if (d.getDay() !== 0 || rand() < 0.3) { // lighter Sundays
        const start = d.getTime() + (8.5 + rand() * 1.5) * 3600000;
        simulate(start, start + (dayLen + rand() * 3.5) * 3600000, day);
      }
      store[key(d.getTime(), uid)] = day;
    }
  }
  store.lastUser = "alex";
  store[`prefs:${SAM}`] = { theme: "sunset", paused: false };
  // password hashes are computed once (async), before any page reads storage
  const ready = (async () => {
    const hash = async (pw) => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, k, 256);
      const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
      return { salt: b64(salt), hash: b64(bits), iterations: 1000 };
    };
    store.users = {
      [ALEX]: { id: ALEX, username: "alex", displayName: "Alex Kim", role: "admin", perms: {}, disabled: false, createdAt: now - 20 * 86400000, lastLoginAt: now - 3600000, ...(await hash("demo1234")) },
      [SAM]: { id: SAM, username: "sam", displayName: "Sam Rivera", role: "member", perms: { viewAgents: true, requestChanges: true, approvePermissions: true, pauseTracking: true }, disabled: false, createdAt: now - 9 * 86400000, lastLoginAt: now - 86400000, ...(await hash("demo1234")) },
      udemojordan03: { id: "udemojordan03", username: "jordan", displayName: "Jordan Lee", role: "member", perms: { viewAgents: false, requestChanges: false, approvePermissions: false, pauseTracking: false }, disabled: false, createdAt: now - 2 * 86400000, lastLoginAt: 0, ...(await hash("demo1234")) },
    };
  })();

  const session = {};
  const listeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  function area(data, name) {
    return {
      async get(keys) {
        await ready;
        if (name === "session" && data.auth) {
          data.live = { uid: data.auth.userId, state: "aiWaiting", host: "claude.ai", generating: true, isAI: true, at: Date.now() };
        }
        if (keys == null) return clone(data);
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (data[k] !== undefined) out[k] = clone(data[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: clone(v) }; data[k] = clone(v); }
        listeners.forEach((f) => f(changes, name));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete data[k];
      },
    };
  }

  // ---- sample agent inbox (stands in for bridge/server.mjs) ----
  const M = 60000;
  const S1 = "demo-session-auth", S2 = "demo-session-docs";
  const P1 = "Refactor the auth module to use the new token service, and make sure everything is tested.";
  const P2 = "Write release notes for v2.1 and update the README.";
  const task = (o) => ({ read: true, review: "none", feedback: [], source: "claude-code", cwd: "C:/projects/booking-app", ...o, updatedAt: now });
  const demoTasks = [
    task({ id: "t1", sessionId: S1, parentPrompt: P1, agent: "Explore", title: "Map every caller of the old auth helpers", status: "completed",
      startedAt: now - 52 * M, endedAt: now - 49 * M, read: true, review: "accepted",
      prompt: "Find all call sites of auth.legacyLogin, auth.refresh and auth.verify across the repo. Report file paths and line numbers, grouped by module.",
      result: "Found 14 call sites in 6 files:\n\nsrc/api/session.js: 41, 88, 120 (legacyLogin, refresh)\nsrc/api/admin.js: 17 (verify)\nsrc/middleware/requireUser.js: 9, 33 (verify)\nsrc/jobs/cleanup.js: 22 (refresh)\nsrc/routes/booking.js: 55, 61, 140, 188 (verify)\ntest/legacy/auth.spec.js: 12, 30, 47 (all three)\n\nNo dynamic calls (e.g. auth[name]) were found." }),
    task({ id: "t2", sessionId: S1, parentPrompt: P1, agent: "general-purpose", title: "Rewrite session.js on the token service", status: "completed",
      startedAt: now - 48 * M, endedAt: now - 37 * M, read: false,
      prompt: "Rewrite src/api/session.js so login/refresh go through TokenService instead of auth.legacyLogin / auth.refresh. Keep the public API of the module unchanged.",
      result: "Rewrote src/api/session.js:\n- login() now calls TokenService.issue() and sets the httpOnly cookie\n- refresh() uses TokenService.rotate(); the old refresh-window logic is gone\n- removed the unused import of ../lib/legacyAuth\n\nPublic exports unchanged (login, logout, refresh, current). Ran the existing session tests: 18 passed." }),
    task({ id: "t3", sessionId: S1, parentPrompt: P1, agent: "general-purpose", title: "Write unit tests for the token service", status: "completed",
      startedAt: now - 36 * M, endedAt: now - 21 * M, read: true, review: "changes_requested",
      prompt: "Add unit tests for src/lib/tokenService.js covering issue, rotate and revoke. Use the existing test helpers in test/helpers.",
      result: "Added test/lib/tokenService.spec.js with 11 tests (issue: 4, rotate: 4, revoke: 3). All pass.\nCoverage for tokenService.js: 86% lines.",
      feedback: [{ id: "f1", text: "Also cover token expiry and clock skew, and get coverage above 95%.", mode: "next-turn", createdAt: now - 18 * M, status: "delivered", deliveredAt: now - 16 * M }] }),
    task({ id: "t4", sessionId: S1, parentPrompt: P1, agent: "code-reviewer", title: "Review the auth refactor for security issues", status: "running",
      startedAt: now - 4 * M, read: true,
      prompt: "Review the diff of the auth refactor. Look for token leakage, missing validation, and timing-unsafe comparisons." }),
    task({ id: "t5", sessionId: S1, parentPrompt: P1, agent: "general-purpose", title: "Add expiry and clock-skew tests", status: "running",
      startedAt: now - 2 * M, read: true, prompt: "Extend test/lib/tokenService.spec.js with expiry and clock-skew cases; target >95% coverage.", modOf: "t3" }),
    task({ id: "t6", sessionId: S2, parentPrompt: P2, agent: "Explore", title: "Collect merged PRs since v2.0", status: "completed",
      startedAt: now - 130 * M, endedAt: now - 127 * M, read: false,
      prompt: "List the PRs merged since tag v2.0 with their titles and labels.",
      result: "23 PRs merged since v2.0:\n- 9 labelled feature (agent inbox, themes, trends view, …)\n- 10 labelled fix\n- 4 labelled chore/docs\n\nFull list with links saved to notes/v2.1-prs.md." }),
    task({ id: "t7", sessionId: S2, parentPrompt: P2, agent: "general-purpose", title: "Draft the v2.1 release notes", status: "failed",
      startedAt: now - 126 * M, endedAt: now - 120 * M, read: false,
      prompt: "Draft CHANGELOG.md entries for v2.1 from notes/v2.1-prs.md, grouped into Features / Fixes / Other.",
      error: "Couldn't write CHANGELOG.md: the file is open in another program (EBUSY)." }),
  ];
  const demoDb = Object.fromEntries(demoTasks.map((t) => [t.id, t]));
  const permBase = { source: "claude-code", cwd: "C:/projects/booking-app", read: false, updatedAt: now };
  const demoPerms = Object.fromEntries([
    { id: "p1", sessionId: S1, parentPrompt: P1, agent: "general-purpose", isSubagent: true, toolName: "Bash", summary: "git push origin feature/token-service --force-with-lease",
      ruleName: "Ask before git push", status: "pending", createdAt: now - 40000, expiresAt: now + 260000, onTimeout: "deny",
      toolInput: JSON.stringify({ command: "git push origin feature/token-service --force-with-lease", description: "Push the refactor branch" }, null, 2) },
    { id: "p2", sessionId: S1, parentPrompt: P1, agent: "main agent", isSubagent: false, toolName: "PowerShell", summary: "Remove-Item -Recurse -Force .\\dist, .\\coverage",
      ruleName: "Ask before deleting files", status: "pending", createdAt: now - 15000, expiresAt: now + 285000, onTimeout: "deny",
      toolInput: JSON.stringify({ command: "Remove-Item -Recurse -Force .\\dist, .\\coverage" }, null, 2) },
    { id: "p3", sessionId: S1, parentPrompt: P1, agent: "general-purpose", isSubagent: true, toolName: "Bash", summary: "npm install --save-dev @vitest/coverage-v8",
      ruleName: "Ask before installing packages", status: "approved", decidedBy: "Alex Kim", note: "OK, dev dependency only.", createdAt: now - 30 * 60000, decidedAt: now - 29 * 60000, read: true },
    { id: "p4", sessionId: S2, parentPrompt: P2, agent: "Explore", isSubagent: true, toolName: "Read", summary: "C:/projects/booking-app/.env",
      ruleName: "Never read .env files", status: "blocked", decidedBy: "rule", createdAt: now - 125 * 60000, decidedAt: now - 125 * 60000, read: true },
    { id: "p5", sessionId: S2, parentPrompt: P2, agent: "main agent", isSubagent: false, toolName: "Bash", summary: "git push origin main",
      ruleName: "Ask before git push", status: "denied", decidedBy: "Sam Rivera", note: "Open a PR instead of pushing to main.", createdAt: now - 118 * 60000, decidedAt: now - 117 * 60000, read: true },
    { id: "p6", sessionId: S2, parentPrompt: P2, agent: "docs-writer", isSubagent: true, toolName: "Bash", summary: "rm docs/old-changelog.md",
      ruleName: "Ask before deleting files", status: "expired", onTimeout: "deny", createdAt: now - 200 * 60000, decidedAt: now - 195 * 60000, read: true },
  ].map((x) => [x.id, { ...permBase, ...x }]));
  let demoRules = {
    timeoutSec: 300, onTimeout: "deny", updatedAt: now - 3 * 86400000, updatedBy: "Alex Kim",
    rules: [
      { id: "r-delete", name: "Ask before deleting files", enabled: true, tools: "Bash,PowerShell", match: String.raw`(^|[\s;&|(])(rm|rmdir|del|erase|rd|Remove-Item|unlink)(\s|$)`, matchType: "regex", scope: "any", action: "ask" },
      { id: "r-push", name: "Ask before git push", enabled: true, tools: "Bash,PowerShell", match: String.raw`git\s+push`, matchType: "regex", scope: "any", action: "ask" },
      { id: "r-install", name: "Ask before installing packages", enabled: true, tools: "Bash,PowerShell", match: String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b`, matchType: "regex", scope: "any", action: "ask" },
      { id: "r-env", name: "Never read .env files", enabled: true, tools: "Read,Bash,PowerShell", match: ".env", matchType: "contains", scope: "any", action: "deny" },
      { id: "r-web", name: "Ask before sub-agents fetch web pages", enabled: false, tools: "WebFetch", match: "", matchType: "contains", scope: "subagents", action: "ask" },
    ],
  };
  globalThis.FL_DEMO_BRIDGE = async (method, pathname, body) => {
    const [, , , id, sub] = pathname.split("?")[0].split("/");
    if (pathname.startsWith("/api/health")) return { ok: true, tasks: Object.keys(demoDb).length, rules: demoRules.rules.filter((r) => r.enabled).length, claudeAvailable: true };
    if (pathname.startsWith("/api/changes")) { await new Promise((r) => setTimeout(r, 1500)); return { version: 1 }; }
    if (pathname === "/api/rules") {
      if (method === "PUT") { new RegExp("x"); demoRules = { ...clone(body), updatedAt: Date.now() }; for (const r of demoRules.rules) if (r.matchType === "regex") new RegExp(r.match); }
      return clone(demoRules);
    }
    if (method === "GET" && pathname.startsWith("/api/permissions")) return { permissions: clone(Object.values(demoPerms)), now: Date.now() };
    if (pathname.startsWith("/api/permissions/")) {
      const pr = demoPerms[decodeURIComponent(id || "")];
      if (!pr) throw new Error("no such request");
      if (sub === "decide") {
        if (pr.status !== "pending") throw new Error(`This request is already ${pr.status}.`);
        Object.assign(pr, { status: body.decision === "allow" ? "approved" : "denied", note: body.note, decidedBy: body.by, decidedAt: Date.now(), read: true, updatedAt: Date.now() });
      } else if (method === "PATCH") Object.assign(pr, body, { updatedAt: Date.now() });
      return clone(pr);
    }
    if (method === "GET" && pathname.startsWith("/api/tasks")) {
      return { tasks: clone(Object.values(demoDb)), sessions: { [S1]: { id: S1, cwd: "C:/projects/booking-app" }, [S2]: { id: S2, cwd: "C:/projects/booking-app" } }, now: Date.now(), claudeAvailable: true };
    }
    const t = demoDb[decodeURIComponent(id || "")];
    if (!t) throw new Error("no such task");
    if (method === "PATCH") {
      Object.assign(t, body, { updatedAt: Date.now() });
      return clone(t);
    }
    if (method === "POST" && sub === "feedback") {
      const fb = { id: `f${Date.now()}`, text: body.text, mode: body.mode, createdAt: Date.now(), status: "pending" };
      t.feedback.push(fb);
      t.review = "changes_requested";
      t.updatedAt = Date.now();
      if (body.mode === "run-now") {
        const mid = `m${Date.now()}`;
        demoDb[mid] = task({ id: mid, sessionId: t.sessionId, parentPrompt: body.text, agent: "claude (resumed)", title: `Changes: ${t.title}`,
          status: "running", startedAt: Date.now(), prompt: body.text, modOf: t.id, updatedAt: Date.now() });
        fb.status = "running";
        fb.resultTaskId = mid;
        setTimeout(() => {
          Object.assign(demoDb[mid], { status: "completed", endedAt: Date.now(), read: false, updatedAt: Date.now(), result: `Done. Applied the requested changes:\n\n${body.text}\n\n(This is demo output.)` });
          fb.status = "done";
          t.updatedAt = Date.now();
        }, 6000);
      }
      return { feedback: clone(fb), task: clone(t) };
    }
    throw new Error("not found");
  };

  globalThis.chrome = {
    storage: { local: area(store, "local"), session: area(session, "session"), onChanged: { addListener: (f) => listeners.push(f) } },
    runtime: { getURL: (p) => p, openOptionsPage: () => { location.href = "dashboard.html#settings"; } },
    tabs: { create: ({ url }) => { location.href = url; } },
  };
})();
