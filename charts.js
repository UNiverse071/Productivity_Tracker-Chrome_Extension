// Tiny dependency-free SVG chart helpers (extension pages can't load remote
// libraries). Every mark carries a `data-tip` that the shared tooltip shows.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Draw at the container's real pixel width so text isn't scaled up or down.
function widthOf(container, fallback = 640) {
  return Math.max(200, Math.floor(container.clientWidth) || fallback);
}

function newSvg(container, w, h) {
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", role: "img" });
  svg.style.display = "block";
  container.replaceChildren(svg);
  return svg;
}

// ---- tooltip ----------------------------------------------------------------

(function initTooltip() {
  const tip = document.createElement("div");
  tip.className = "tip";
  if (document.body) document.body.appendChild(tip);
  else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(tip));
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.style.opacity = 0; return; }
    tip.textContent = t.getAttribute("data-tip");
    tip.style.opacity = 1;
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  });
})();

// ---- donut -------------------------------------------------------------------

function drawDonut(container, parts, { size = 160, thickness = 22, center = "", sub = "" } = {}) {
  const svg = newSvg(container, size, size);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const total = parts.reduce((a, p) => a + p.value, 0);
  svgEl("circle", { cx: c, cy: c, r, fill: "none", class: "track", "stroke-width": thickness }, svg);
  if (total > 0) {
    const circ = 2 * Math.PI * r;
    const gap = parts.filter((p) => p.value > 0).length > 1 ? 2 : 0;
    let offset = 0;
    for (const p of parts) {
      if (!p.value) continue;
      const len = (p.value / total) * circ;
      svgEl("circle", {
        cx: c, cy: c, r, fill: "none", class: `s-${p.cls}`, "stroke-width": thickness,
        "stroke-dasharray": `${Math.max(0, len - gap)} ${circ}`,
        "stroke-dashoffset": -offset,
        transform: `rotate(-90 ${c} ${c})`,
        "data-tip": `${p.label}: ${p.text} (${Math.round((p.value / total) * 100)}%)`,
      }, svg);
      offset += len;
    }
  }
  svgEl("text", { x: c, y: c + (sub ? 2 : 8), "text-anchor": "middle", class: "donut-center" }, svg).textContent = center;
  if (sub) svgEl("text", { x: c, y: c + 22, "text-anchor": "middle", class: "donut-sub" }, svg).textContent = sub;
}

// ---- stacked columns ----------------------------------------------------------
// columns: [{ label, bucket: {active, aiWaiting, idle}, tip }]

function drawStackedColumns(container, columns, { height = 180, labelEvery = 1, yFormat = flFormatDuration } = {}) {
  const w = widthOf(container), padL = 46, padB = 22, padT = 8;
  const svg = newSvg(container, w, height);
  const innerH = height - padB - padT;
  const max = Math.max(1, ...columns.map((c) => flSum(c.bucket)));
  // gridlines at 0, 50%, 100% (just the baseline when there's no data yet)
  for (const f of max > 1000 ? [0, 0.5, 1] : [0]) {
    const y = padT + innerH * (1 - f);
    svgEl("line", { x1: padL, x2: w, y1: y, y2: y, class: f ? "grid" : "axis" }, svg);
    svgEl("text", { x: padL - 6, y: y + 4, "text-anchor": "end", class: "tick" }, svg).textContent = f ? yFormat(max * f) : "0";
  }
  const slot = (w - padL) / columns.length;
  const bw = Math.max(3, Math.min(28, slot * 0.68));
  columns.forEach((col, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    let y = padT + innerH;
    const g = svgEl("g", {}, svg);
    for (const s of FL_STATES) {
      const v = col.bucket[s];
      if (!v) continue;
      const h = (v / max) * innerH;
      const drawH = Math.max(0, h - (h > 3 ? 2 : 0)); // 2px surface gap between segments
      svgEl("rect", { x, y: y - h, width: bw, height: drawH || h, rx: 2, class: `f-${s}` }, g);
      y -= h;
    }
    // full-height invisible hit target
    svgEl("rect", { x: padL + slot * i, y: padT, width: slot, height: innerH, fill: "transparent", "data-tip": col.tip }, g);
    if (i % labelEvery === 0) {
      svgEl("text", { x: x + bw / 2, y: height - 6, "text-anchor": "middle", class: "tick" }, svg).textContent = col.label;
    }
  });
}

// ---- simple columns (single series) ------------------------------------------

function drawColumns(container, items, { height = 160, cls = "aiWaiting" } = {}) {
  const w = widthOf(container, 400), padB = 22, padT = 18;
  const svg = newSvg(container, w, height);
  const innerH = height - padB - padT;
  const max = Math.max(1, ...items.map((d) => d.value));
  svgEl("line", { x1: 0, x2: w, y1: padT + innerH, y2: padT + innerH, class: "axis" }, svg);
  const slot = w / items.length;
  const bw = Math.min(48, slot * 0.6);
  items.forEach((d, i) => {
    const h = (d.value / max) * innerH;
    const x = slot * i + (slot - bw) / 2;
    if (d.value) svgEl("rect", { x, y: padT + innerH - h, width: bw, height: h, rx: 4, class: `f-${cls}` }, svg);
    svgEl("text", { x: x + bw / 2, y: padT + innerH - h - 5, "text-anchor": "middle", class: "val" }, svg).textContent = d.value || "";
    svgEl("text", { x: x + bw / 2, y: height - 6, "text-anchor": "middle", class: "tick" }, svg).textContent = d.label;
    svgEl("rect", { x: slot * i, y: 0, width: slot, height, fill: "transparent", "data-tip": d.tip }, svg);
  });
}

// ---- horizontal bars --------------------------------------------------------------

function drawHBars(container, rows, { cls = "aiWaiting", format = flFormatDuration } = {}) {
  container.replaceChildren();
  const max = Math.max(1, ...rows.map((r) => r.value));
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "hbar";
    row.dataset.tip = r.tip;
    const name = document.createElement("span");
    name.className = "hbar-label";
    name.textContent = r.label;
    const track = document.createElement("span");
    track.className = "hbar-track";
    const fill = document.createElement("span");
    fill.className = `hbar-fill f-${cls}`;
    fill.style.width = `${(r.value / max) * 100}%`;
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "hbar-val";
    val.textContent = format(r.value);
    row.append(name, track, val);
    container.appendChild(row);
  }
}

// ---- line (0â€“100%) with crosshair hover ---------------------------------------

function drawPercentLine(container, points, { height = 160 } = {}) {
  const w = widthOf(container), padL = 46, padB = 30, padT = 10, padR = 12;
  const svg = newSvg(container, w, height);
  const innerH = height - padB - padT, innerW = w - padL - padR;
  for (const f of [0, 0.5, 1]) {
    const y = padT + innerH * (1 - f);
    svgEl("line", { x1: padL, x2: w - padR, y1: y, y2: y, class: f ? "grid" : "axis" }, svg);
    svgEl("text", { x: padL - 6, y: y + 4, "text-anchor": "end", class: "tick" }, svg).textContent = `${f * 100}%`;
  }
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xy = points.map((p, i) => [padL + step * i, p.value == null ? null : padT + innerH * (1 - p.value / 100)]);
  let d = "", pen = false;
  xy.forEach(([x, y]) => {
    if (y == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    pen = true;
  });
  if (d) svgEl("path", { d, class: "line" }, svg);
  const labelEvery = Math.ceil(points.length / 10);
  points.forEach((p, i) => {
    const [x, y] = xy[i];
    if (y != null) svgEl("circle", { cx: x, cy: y, r: 4, class: "dot" }, svg);
    if (i % labelEvery === 0) svgEl("text", { x, y: height - 6, "text-anchor": "middle", class: "tick" }, svg).textContent = p.label;
  });
  // crosshair
  const cross = svgEl("line", { y1: padT, y2: padT + innerH, class: "cross", opacity: 0 }, svg);
  points.forEach((p, i) => {
    const x = padL + step * i;
    const hit = svgEl("rect", { x: x - step / 2, y: 0, width: Math.max(step, 12), height, fill: "transparent", "data-tip": p.tip }, svg);
    hit.addEventListener("mouseenter", () => { cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 1); });
    hit.addEventListener("mouseleave", () => cross.setAttribute("opacity", 0));
  });
}

// ---- day timeline -------------------------------------------------------------------
// segments: [startMs, endMs, stateIdx, host]

function drawTimeline(container, segments, dayStartMs, { fromHour = 0, toHour = 24 } = {}) {
  const w = widthOf(container), h = 58, barH = 30, padT = 4;
  const svg = newSvg(container, w, h);
  const t0 = dayStartMs + fromHour * 3600000;
  const span = (toHour - fromHour) * 3600000;
  svgEl("rect", { x: 0, y: padT, width: w, height: barH, rx: 6, class: "track-fill" }, svg);
  for (const [s, e, si, host] of segments) {
    const x = ((s - t0) / span) * w;
    const width = Math.max(1, ((e - s) / span) * w);
    if (x + width < 0 || x > w) continue;
    const st = FL_STATES[si];
    const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    svgEl("rect", {
      x, y: padT, width, height: barH, class: `f-${st}`,
      "data-tip": `${time(s)}â€“${time(e)} Â· ${FL_LABELS[st]} Â· ${host} (${flFormatDuration(e - s)})`,
    }, svg);
  }
  const hours = toHour - fromHour;
  const every = Math.max(1, Math.ceil(hours / Math.max(1, Math.floor(w / 60))));
  for (let i = 0; i <= hours; i += every) {
    const x = (i / hours) * w;
    const anchor = i === 0 ? "start" : i + every > hours && x > w - 30 ? "end" : "middle";
    svgEl("text", { x, y: h - 4, "text-anchor": anchor, class: "tick" }, svg)
      .textContent = `${String((fromHour + i) % 24).padStart(2, "0")}:00`;
  }
}
