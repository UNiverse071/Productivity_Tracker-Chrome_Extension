// Runs in every page. Watches your input and (on AI chat sites) whether a
// response is being generated, then reports a classified slice of time to the
// background worker every few seconds — but only while this tab is the one
// you're actually looking at (visible + focused).

(() => {
  // If an older copy of this script is still around (e.g. after the extension
  // was reloaded), shut it down so only one instance reports.
  if (typeof window.__focusLedgerStop === "function") window.__focusLedgerStop();

  const TICK_MS = 5000;
  const GEN_POLL_MS = 1000;
  const MAX_DELTA_MS = 15000; // timers get throttled; never credit a huge gap

  let settings = { ...FL_DEFAULTS };
  let isAI = false;

  const now = Date.now();
  let lastKeyAt = now;
  let lastPointerAt = now;
  let lastSubmitAt = 0;
  let lastGenEndAt = 0;
  let generating = false;
  let lastTick = now;

  function refreshSettings(s) {
    settings = s;
    isAI = flMatchesDomain(location.hostname, settings.aiDomains);
  }
  flGetSettings().then(refreshSettings).catch(() => {});
  const onStorage = (changes, area) => {
    if (area === "local" && changes.settings) {
      refreshSettings({ ...FL_DEFAULTS, ...(changes.settings.newValue || {}) });
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

  // ---- input tracking -----------------------------------------------------

  function isTextTarget(el) {
    if (!el) return false;
    return el.isContentEditable || el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search|)$/i.test(el.type || ""));
  }

  const onKey = (e) => {
    lastKeyAt = Date.now();
    // Enter (without Shift) inside a text box on an AI site = prompt submitted.
    if (isAI && e.key === "Enter" && !e.shiftKey && !e.isComposing && isTextTarget(e.target)) {
      lastSubmitAt = lastKeyAt;
    }
  };

  const SEND_RE = /\b(send|submit)\b/i;
  const onClick = (e) => {
    lastPointerAt = Date.now();
    if (!isAI) return;
    const btn = e.target.closest && e.target.closest("button, [role=button]");
    if (!btn) return;
    const label = [btn.getAttribute("aria-label"), btn.getAttribute("data-testid"),
      btn.getAttribute("title"), btn.type === "submit" ? "submit" : ""].join(" ");
    if (SEND_RE.test(label)) lastSubmitAt = lastPointerAt;
  };

  const onPointer = () => { lastPointerAt = Date.now(); };

  const opts = { capture: true, passive: true };
  window.addEventListener("keydown", onKey, opts);
  window.addEventListener("click", onClick, opts);
  for (const t of ["mousemove", "mousedown", "wheel", "scroll", "touchstart"]) {
    window.addEventListener(t, onPointer, opts);
  }

  // ---- AI generation detection ---------------------------------------------
  // Chat UIs swap the send button for a "stop" button while streaming.

  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',           // ChatGPT
    'button[aria-label="Stop response"]',          // Claude, Gemini
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]',
    'button[data-testid*="stop" i]',
  ].join(",");
  const STOP_LABEL_RE = /^stop(\s+(generating|response|streaming|answering))?$/i;

  function detectGenerating() {
    if (document.querySelector(STOP_SELECTORS)) return true;
    for (const b of document.querySelectorAll("button[aria-label]")) {
      if (STOP_LABEL_RE.test(b.getAttribute("aria-label").trim())) return true;
    }
    return false;
  }

  function pollGenerating() {
    if (!isAI) return;
    const g = detectGenerating();
    if (generating && !g) lastGenEndAt = Date.now();
    generating = g;
  }

  // ---- classification -------------------------------------------------------

  function classify(t) {
    const thr = settings.idleThresholdSec * 1000;
    const typing = t - lastKeyAt < thr;
    const pointing = t - lastPointerAt < thr;

    // Submitted a prompt and haven't typed since, the response hasn't finished,
    // and we're within the safety cap.
    const pendingSubmit = isAI && lastSubmitAt > 0 &&
      lastKeyAt <= lastSubmitAt &&
      lastGenEndAt < lastSubmitAt &&
      t - lastSubmitAt < settings.maxWaitSec * 1000;

    if (typing) return "active";
    // While waiting on the model, wiggling the mouse doesn't count as working.
    if (isAI && (generating || pendingSubmit)) return "aiWaiting";
    if (pointing) return "active";
    return "idle";
  }

  function tick() {
    if (!chrome.runtime?.id) return stop(); // extension reloaded/removed
    const t = Date.now();
    const delta = Math.min(t - lastTick, MAX_DELTA_MS);
    lastTick = t;

    // Only the tab you're looking at counts.
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;

    pollGenerating();
    const msg = {
      type: "heartbeat",
      state: classify(t),
      delta,
      host: location.hostname || location.protocol.replace(":", ""),
      generating,
      isAI,
    };
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      stop();
    }
  }

  // When you come back to a tab, don't credit the time you were away.
  const onVisible = () => { lastTick = Date.now(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);

  const tickTimer = setInterval(tick, TICK_MS);
  const genTimer = setInterval(() => {
    if (document.visibilityState === "visible") pollGenerating();
  }, GEN_POLL_MS);

  function stop() {
    clearInterval(tickTimer);
    clearInterval(genTimer);
    window.removeEventListener("keydown", onKey, opts);
    window.removeEventListener("click", onClick, opts);
    for (const t of ["mousemove", "mousedown", "wheel", "scroll", "touchstart"]) {
      window.removeEventListener(t, onPointer, opts);
    }
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    if (window.__focusLedgerStop === stop) delete window.__focusLedgerStop;
  }
  window.__focusLedgerStop = stop;
})();
