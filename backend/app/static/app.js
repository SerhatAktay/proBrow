const state = {
  ref: "chr1",
  start: 0,
  end: 50000,
  bins: 1200,
  yScale: 1.0,
  smoothUi: 0,     // 0..100
  spikyUi: 0,      // 0..100 — unsharp-mask sharpening (k/K)
  perSampleScale: false, // when true each lane scales to its own max (p)
  tracks: [], // raw config tracks (per file)
  regionData: null,
  trackOrder: null, // array of track keys in display order
  trackGroups: null, // array of arrays of track keys (lanes). null => one lane per trackOrder
  genes: [],
  dragging: false,
  dragStartX: 0,
  dragStartStart: 0,
  dragStartEnd: 0,
  // Lock autoscale yMax so it doesn't change while panning/zooming.
  // This value is in raw data units (before applying yScale factor).
  yMaxLocked: null,
};

const el = {
  signalCanvas: document.getElementById("signalCanvas"),
  geneCanvas: document.getElementById("geneCanvas"),
  status: document.getElementById("status"),
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  geneSuggestList: document.getElementById("geneSuggestList"),
  helpButton: document.getElementById("helpButton"),
  helpOverlay: document.getElementById("helpOverlay"),
  helpBody: document.getElementById("helpBody"),
  helpClose: document.getElementById("helpClose"),
  tracksButton: document.getElementById("tracksButton"),
  tracksOverlay: document.getElementById("tracksOverlay"),
  tracksBody: document.getElementById("tracksBody"),
  tracksClose: document.getElementById("tracksClose"),
  overlayBtn: document.getElementById("overlayBtn"),
  unoverlayBtn: document.getElementById("unoverlayBtn"),
  clearOverlayBtn: document.getElementById("clearOverlayBtn"),
  tooltip: document.getElementById("tooltip"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  exportButton: document.getElementById("exportButton"),
};

function comma(n) {
  return Intl.NumberFormat("en-US").format(n);
}

function formatBp(bp) {
  if (bp >= 1_000_000) return `${(bp / 1_000_000).toFixed(2)}Mb`;
  if (bp >= 1_000) return `${Math.round(bp / 1_000)}kb`;
  return `${bp}bp`;
}

function formatSignalVal(v) {
  if (v === 0) return "0";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

// ---------------------------------------------------------------------------
// URL state — encode/decode the current locus in the fragment (#ref:start-end)
// ---------------------------------------------------------------------------

function pushUrlState() {
  const hash = `#${state.ref}:${state.start}-${state.end}`;
  try {
    window.history.replaceState(null, "", hash);
  } catch {
    // ignore (e.g. cross-origin restrictions in tests)
  }
}

function parseUrlState() {
  const hash = (window.location.hash || "").slice(1);
  if (!hash) return false;
  const m = /^([^:]+):(\d+)-(\d+)$/.exec(hash);
  if (!m) return false;
  const s = parseInt(m[2], 10);
  const e = parseInt(m[3], 10);
  if (!isFinite(s) || !isFinite(e) || e <= s) return false;
  state.ref = m[1];
  state.start = s;
  state.end = e;
  return true;
}

function niceStep(target) {
  // target in bp; return 1/2/5 * 10^n
  const t = Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(t)));
  const mant = t / pow;
  const m = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
  return m * pow;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function regionLen() {
  return Math.max(1, state.end - state.start);
}

function binsUsed() {
  return state._lastBinsUsed || (regionLen() <= 20000 ? regionLen() : state.bins);
}

function binIndexFromClientX(clientX) {
  const rect = el.signalCanvas.getBoundingClientRect();
  const rel = clamp((clientX - rect.left) / rect.width, 0, 1);
  const n = binsUsed();
  return clamp(Math.floor(rel * Math.max(1, n - 1)), 0, Math.max(0, n - 1));
}

function coordFromClientX(clientX) {
  const rect = el.signalCanvas.getBoundingClientRect();
  const rel = clamp((clientX - rect.left) / rect.width, 0, 1);
  return Math.floor(state.start + rel * regionLen());
}

function setLoading(on) {
  if (!el.loadingOverlay) return;
  el.loadingOverlay.classList.toggle("hidden", !on);
  el.loadingOverlay.setAttribute("aria-hidden", on ? "false" : "true");
}

function lenFromZoomValue(z) {
  // z in [0..100] mapped logarithmically to [50bp .. 50Mb]
  const minLen = 50;
  const maxLen = 50_000_000;
  const t = clamp(z / 100, 0, 1);
  const logMin = Math.log(minLen);
  const logMax = Math.log(maxLen);
  const logLen = logMin + (1 - t) * (logMax - logMin);
  return Math.round(Math.exp(logLen));
}

function zoomValueFromLen(len) {
  const minLen = 50;
  const maxLen = 50_000_000;
  const cl = clamp(len, minLen, maxLen);
  const logMin = Math.log(minLen);
  const logMax = Math.log(maxLen);
  const t = 1 - (Math.log(cl) - logMin) / (logMax - logMin);
  return clamp(t * 100, 0, 100);
}

function yScaleFactorFromValue(v) {
  // v in [0..100] -> factor in [0.1 .. 10] (log)
  const t = clamp(v / 100, 0, 1);
  const logMin = Math.log(0.1);
  const logMax = Math.log(10);
  return Math.exp(logMin + t * (logMax - logMin));
}

function yScaleValueFromFactor(f) {
  const ff = clamp(f, 0.1, 10);
  const logMin = Math.log(0.1);
  const logMax = Math.log(10);
  const t = (Math.log(ff) - logMin) / (logMax - logMin);
  return Math.round(clamp(t * 100, 0, 100));
}

const SHORTCUTS = [
  { keys: ["Wheel"], label: "Zoom (smooth)" },
  { keys: ["Drag"], label: "Pan (signal or genes)" },
  { keys: ["Shift", "Drag"], label: "Zoom to selection" },
  { keys: ["→", "←"], label: "Pan right/left" },
  { keys: ["+", "-"], label: "Zoom in/out" },
  { keys: ["[", "]"], label: "Scale (Y) down/up" },
  { keys: ["a"], label: "Autoscale Y to current view" },
  { keys: ["s", "S"], label: "Smooth less/more (bp-aware)" },
  { keys: ["k", "K"], label: "Sharpen less/more (unsharp mask)" },
  { keys: ["p"], label: "Toggle per-sample Y scale" },
  { keys: ["b", "B"], label: "Bins less/more (performance/detail)" },
  { keys: ["e"], label: "Export current view as PNG" },
  { keys: ["g"], label: "Focus search" },
  { keys: ["?"], label: "Toggle shortcuts help" },
  { keys: ["Esc"], label: "Close shortcuts help" },
];

function renderHelp() {
  if (!el.helpBody) return;
  el.helpBody.innerHTML = "";
  for (const s of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "shortcutRow";
    const keys = document.createElement("div");
    keys.className = "shortcutKeys";
    for (const k of s.keys) {
      const kb = document.createElement("kbd");
      kb.textContent = k;
      keys.appendChild(kb);
    }
    const label = document.createElement("div");
    label.textContent = s.label;
    row.appendChild(keys);
    row.appendChild(label);
    el.helpBody.appendChild(row);
  }
}

function setHelpOpen(open) {
  if (!el.helpOverlay) return;
  el.helpOverlay.classList.toggle("hidden", !open);
  el.helpOverlay.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) renderHelp();
}

function trackKey(t) {
  return String(t?.id || t?.name || "");
}

function ensureTrackOrderFromRegion() {
  if (!state.regionData?.tracks?.length) return;
  if (Array.isArray(state.trackOrder) && state.trackOrder.length) return;
  state.trackOrder = state.regionData.tracks.map(trackKey);
}

function applyTrackOrderToRegion() {
  const data = state.regionData;
  if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return;
  ensureTrackOrderFromRegion();
  const order = Array.isArray(state.trackOrder) ? state.trackOrder : null;
  if (!order || !order.length) return;
  const byKey = new Map(data.tracks.map((t) => [trackKey(t), t]));
  const used = new Set();
  const out = [];
  for (const k of order) {
    const t = byKey.get(k);
    if (t && !used.has(k)) {
      out.push(t);
      used.add(k);
    }
  }
  // append any new/unknown tracks
  for (const t of data.tracks) {
    const k = trackKey(t);
    if (!used.has(k)) out.push(t);
  }
  data.tracks = out;
}

function ensureTrackGroups() {
  ensureTrackOrderFromRegion();
  if (Array.isArray(state.trackGroups) && state.trackGroups.length) return;
  state.trackGroups = state.trackOrder.map((k) => [k]);
}

function normalizeTrackGroupsToOrder() {
  ensureTrackOrderFromRegion();
  ensureTrackGroups();
  const order = state.trackOrder.slice();
  const known = new Set(order);
  const seen = new Set();
  const out = [];
  for (const g of state.trackGroups) {
    const gg = (Array.isArray(g) ? g : []).filter((k) => known.has(k) && !seen.has(k));
    if (!gg.length) continue;
    gg.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (const k of gg) seen.add(k);
    out.push(gg);
  }
  for (const k of order) {
    if (!seen.has(k)) out.push([k]);
  }
  state.trackGroups = out;
}

function displayedTrackGroups() {
  normalizeTrackGroupsToOrder();
  return state.trackGroups;
}

function renderTracksOverlay() {
  if (!el.tracksBody) return;
  el.tracksBody.innerHTML = "";
  const tracks = state.regionData?.tracks || [];
  if (!tracks.length) {
    const d = document.createElement("div");
    d.className = "hint";
    d.textContent = "No tracks loaded yet.";
    el.tracksBody.appendChild(d);
    return;
  }

  let dragKey = null;
  const selected = new Set();
  normalizeTrackGroupsToOrder();
  const nameByKey = new Map(tracks.map((t) => [trackKey(t), t.name || t.id || trackKey(t)]));

  function groupForKey(k) {
    const groups = displayedTrackGroups();
    const gi = groups.findIndex((g) => g.includes(k));
    return gi >= 0 ? groups[gi] : [k];
  }

  function moveKeyToIndex(key, newIndex) {
    ensureTrackOrderFromRegion();
    const order = state.trackOrder;
    const from = order.indexOf(key);
    if (from < 0) return;
    const clamped = clamp(newIndex, 0, order.length - 1);
    if (clamped === from) return;
    order.splice(from, 1);
    order.splice(clamped, 0, key);
    applyTrackOrderToRegion();
    renderTracksOverlay();
    draw();
  }

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const key = trackKey(t);
    const row = document.createElement("div");
    row.className = "trackRow";
    row.draggable = true;
    row.dataset.key = key;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "trackCheck";
    check.addEventListener("change", () => {
      if (check.checked) selected.add(key);
      else selected.delete(key);
    });

    const name = document.createElement("div");
    name.className = "trackName";
    const g = groupForKey(key);
    if (g.length > 1) {
      const others = g
        .filter((k) => k !== key)
        .map((k) => nameByKey.get(k) || k);
      const shown = others.slice(0, 3).join(", ");
      const more = others.length > 3 ? ` +${others.length - 3} more` : "";
      name.textContent = `${t.name || t.id || `Track ${i + 1}`} (overlay with ${shown}${more})`;
    } else {
      name.textContent = t.name || t.id || `Track ${i + 1}`;
    }

    const btns = document.createElement("div");
    btns.className = "trackBtns";

    const up = document.createElement("button");
    up.className = "trackBtn";
    up.type = "button";
    up.textContent = "↑";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      ensureTrackOrderFromRegion();
      const j = state.trackOrder.indexOf(key);
      if (j > 0) {
        const tmp = state.trackOrder[j - 1];
        state.trackOrder[j - 1] = state.trackOrder[j];
        state.trackOrder[j] = tmp;
        applyTrackOrderToRegion();
        renderTracksOverlay();
        draw();
      }
    });

    const down = document.createElement("button");
    down.className = "trackBtn";
    down.type = "button";
    down.textContent = "↓";
    down.disabled = i === tracks.length - 1;
    down.addEventListener("click", () => {
      ensureTrackOrderFromRegion();
      const j = state.trackOrder.indexOf(key);
      if (j >= 0 && j < state.trackOrder.length - 1) {
        const tmp = state.trackOrder[j + 1];
        state.trackOrder[j + 1] = state.trackOrder[j];
        state.trackOrder[j] = tmp;
        applyTrackOrderToRegion();
        renderTracksOverlay();
        draw();
      }
    });

    // Drag-and-drop reordering (HTML5 DnD)
    row.addEventListener("dragstart", (e) => {
      dragKey = key;
      row.classList.add("dragging");
      try {
        e.dataTransfer.setData("text/plain", key);
        e.dataTransfer.effectAllowed = "move";
      } catch {
        // ignore
      }
    });
    row.addEventListener("dragend", () => {
      dragKey = null;
      row.classList.remove("dragging");
      // Clear drop target styling
      el.tracksBody.querySelectorAll(".dropTarget").forEach((n) => n.classList.remove("dropTarget"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault(); // allow drop
      row.classList.add("dropTarget");
      try {
        e.dataTransfer.dropEffect = "move";
      } catch {
        // ignore
      }
    });
    row.addEventListener("dragleave", () => row.classList.remove("dropTarget"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("dropTarget");
      const dropped = dragKey || (function () {
        try {
          return e.dataTransfer.getData("text/plain");
        } catch {
          return "";
        }
      })();
      if (!dropped || dropped === key) return;
      const targetIndex = tracks.findIndex((tt) => trackKey(tt) === key);
      moveKeyToIndex(dropped, targetIndex);
    });

    btns.appendChild(up);
    btns.appendChild(down);
    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(btns);
    el.tracksBody.appendChild(row);
  }

  // Overlay actions (best-effort; overlay UI is optional)
  el.overlayBtn?.addEventListener(
    "click",
    () => {
      const keys = Array.from(selected);
      if (keys.length < 2) return;
      if (keys.length > 2 &&
          !confirm(`You're about to overlay ${keys.length} samples. More than 2 overlays can be hard to read — continue?`)) return;
      normalizeTrackGroupsToOrder();
      const groups = displayedTrackGroups();
      const remaining = groups
        .map((g) => g.filter((k) => !selected.has(k)))
        .filter((g) => g.length);

      const overlayGroup = keys.slice().sort((a, b) => state.trackOrder.indexOf(a) - state.trackOrder.indexOf(b));
      const firstPos = Math.min(...overlayGroup.map((k) => state.trackOrder.indexOf(k)).filter((x) => x >= 0));
      let insertAt = remaining.findIndex((g) => state.trackOrder.indexOf(g[0]) >= firstPos);
      if (insertAt < 0) insertAt = remaining.length;
      remaining.splice(insertAt, 0, overlayGroup);
      state.trackGroups = remaining;
      renderTracksOverlay();
      draw();
    },
    { once: true }
  );

  el.unoverlayBtn?.addEventListener(
    "click",
    () => {
      const keys = new Set(selected);
      if (!keys.size) return;
      normalizeTrackGroupsToOrder();
      const groups = displayedTrackGroups();
      const out = [];
      for (const g of groups) {
        const picked = g.filter((k) => keys.has(k));
        const rest = g.filter((k) => !keys.has(k));
        if (rest.length) out.push(rest);
        for (const k of picked) out.push([k]);
      }
      state.trackGroups = out;
      renderTracksOverlay();
      draw();
    },
    { once: true }
  );

  el.clearOverlayBtn?.addEventListener(
    "click",
    () => {
      ensureTrackOrderFromRegion();
      state.trackGroups = state.trackOrder.map((k) => [k]);
      renderTracksOverlay();
      draw();
    },
    { once: true }
  );
}

function setTracksOpen(open) {
  if (!el.tracksOverlay) return;
  el.tracksOverlay.classList.toggle("hidden", !open);
  el.tracksOverlay.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) renderTracksOverlay();
}

function setStatus(msg) {
  el.status.textContent = msg || "";
}

function statusSmoothHint() {
  const bins = state._lastSmoothBins;
  const bp = state._lastSmoothBp;
  if (typeof bins !== "number" || !isFinite(bins) || bins <= 1) return "";
  if (typeof bp === "number" && isFinite(bp) && bp > 1) {
    return ` • smooth ~${formatBp(bp)} (${Math.round(bins)} bins)`;
  }
  return ` • smooth ${Math.round(bins)} bins`;
}

function getYMaxRaw() {
  if (typeof state.yMaxLocked === "number" && isFinite(state.yMaxLocked) && state.yMaxLocked > 0) {
    return state.yMaxLocked;
  }
  const v = state.regionData?.yMax;
  return typeof v === "number" && isFinite(v) && v > 0 ? v : 1;
}

function resizeCanvasToCSSPixels(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(rect.width * dpr));
  const h = Math.max(10, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

function xToCoord(x, width) {
  const t = clamp(x / width, 0, 1);
  return Math.floor(state.start + t * regionLen());
}

function coordToX(coord, width) {
  const t = (coord - state.start) / regionLen();
  return t * width;
}

function drawRuler(ctx, w, top, bottom) {
  const span = regionLen();
  const pxPerBp = w / Math.max(1, span);
  const desiredPx = 90;
  const step = Math.max(1, Math.round(niceStep(desiredPx / pxPerBp)));

  // When highly zoomed (step small), make minor ticks 1bp so vertical lines can reach 1nt spacing.
  const minor = step <= 10 ? 1 : Math.max(1, Math.round(step / 5));
  const firstMinor = Math.ceil(state.start / minor) * minor;

  ctx.save();
  // background strip
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillRect(0, 0, w, bottom);

  // baseline
  ctx.strokeStyle = "rgba(15,23,42,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, bottom);
  ctx.lineTo(w, bottom);
  ctx.stroke();

  // minor ticks + faint lines
  ctx.strokeStyle = "rgba(15,23,42,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let bp = firstMinor; bp <= state.end; bp += minor) {
    const x = coordToX(bp, w);
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom - 6);
  }
  ctx.stroke();

  // major ticks, labels, and vertical guide lines (full height drawn by caller)
  ctx.fillStyle = "rgba(15,23,42,0.85)";
  ctx.font = "16px ui-sans-serif, system-ui";
  ctx.textBaseline = "top";
  // Reduce label density so text doesn't overlap.
  // Aim for >=120px between labels.
  const pxPerStep = step * pxPerBp;
  const labelEvery = Math.max(1, Math.ceil(120 / Math.max(1, pxPerStep)));
  const firstMajor = Math.ceil(state.start / step) * step;
  let idx = 0;
  for (let bp = firstMajor; bp <= state.end; bp += step, idx++) {
    const x = coordToX(bp, w);
    ctx.strokeStyle = "rgba(15,23,42,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom - 12);
    ctx.stroke();
    if (idx % labelEvery === 0) {
      const label = `${comma(Math.round(bp))}`;
      ctx.fillText(label, x + 2, top + 2);
    }
  }
  // scale hint (step size)
  ctx.fillStyle = "rgba(71,85,105,0.95)";
  ctx.fillText(`step ${formatBp(step)}`, 10, top + 2);
  ctx.restore();

  return { step, minor };
}

async function apiGet(path, signal) {
  const res = await fetch(path, signal ? { signal } : undefined);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
  }
  return await res.json();
}

// Gene-name autocomplete (prefix-based)
let suggestTimer = null;
let currentSuggestAbort = null;

function clearGeneSuggestions() {
  if (!el.geneSuggestList) return;
  el.geneSuggestList.innerHTML = "";
}

function isGenePrefixQuery(q) {
  // Disallow coordinates like chr1:123-456
  if (q.includes(":")) return false;
  // Require gene-like start (letters), then allow typical identifiers.
  return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(q);
}

async function apiSuggest(prefix, signal) {
  const url = `/api/suggest?prefix=${encodeURIComponent(prefix)}&limit=20`;
  return await apiGet(url, signal);
}

async function loadConfig() {
  const cfg = await apiGet("/api/config");
  state.tracks = cfg.tracks || [];
  state.ref = cfg.defaultRef || state.ref;
  state.start = cfg.defaultStart ?? state.start;
  state.end = cfg.defaultEnd ?? state.end;
}

function smoothWindowFromUi(v) {
  // UI is 0..100 where 0 = no smoothing, 100 = very smooth.
  // IMPORTANT: backend smooth is a moving-average window *in bins* after binning.
  // If we let the window grow with bins, it can translate to enormous distances in bp
  // on wide views (and visually "move" peaks). So we cap smoothing in bp units and
  // convert to bins based on current bp-per-bin.
  const t = clamp(v / 100, 0, 1);
  const eased = t * t * t; // slower near 0 (avoid over-smoothing early)
  const binsUsed = state._lastBinsUsed || state.bins;
  const bpPerBin = regionLen() / Math.max(1, binsUsed);

  const maxSmoothBp = 20_000; // cap smoothing to 20kb in genomic space
  const desiredBp = Math.round(1 + eased * (maxSmoothBp - 1));
  let wBins = Math.max(1, Math.round(desiredBp / Math.max(1e-9, bpPerBin)));
  wBins = clamp(wBins, 1, 2001); // backend validation
  // Prefer odd window size so "same" convolution is centered.
  if (wBins > 1 && wBins % 2 === 0) wBins += 1;
  wBins = clamp(wBins, 1, 2001);

  state._lastSmoothBins = wBins;
  state._lastSmoothBp = Math.round(wBins * bpPerBin);
  return wBins;
}

function spikyFromUi(v) {
  // v 0..100 → 0..4 (gentle to aggressive unsharp mask)
  return parseFloat((clamp(v / 100, 0, 1) * 4).toFixed(2));
}

function makeRegionQuery() {
  const params = new URLSearchParams();
  params.set("ref", state.ref);
  params.set("start", String(state.start));
  params.set("end", String(state.end));
  const len = regionLen();
  const bins = len <= 20000 ? len : state.bins;
  state._lastBinsUsed = bins;
  params.set("bins", String(bins));
  params.set("smooth", String(smoothWindowFromUi(state.smoothUi)));
  if (state.spikyUi > 0) {
    params.set("spiky", String(spikyFromUi(state.spikyUi)));
  }
  // Let backend default to all configured tracks.
  return `/api/region?${params.toString()}`;
}

function makeGenesQuery() {
  const params = new URLSearchParams();
  params.set("ref", state.ref);
  params.set("start", String(state.start));
  params.set("end", String(state.end));
  return `/api/genes?${params.toString()}`;
}

let pending = null;
let currentAbort = null;
let refreshSeq = 0;
let refreshDirty = false;
let lastRequestStartedAt = 0;

function nowMs() {
  return performance.now();
}

function startNewRequestIfNeeded() {
  if (!pending) return true;
  // If the user is actively dragging/scrolling, allow canceling an in-flight request
  // but only at a controlled rate to avoid thrashing.
  const age = nowMs() - lastRequestStartedAt;
  if (age >= 120 && currentAbort) {
    currentAbort.abort();
    pending = null;
    return true;
  }
  refreshDirty = true;
  return false;
}

async function refresh() {
  if (pending) {
    refreshDirty = true;
    return;
  }
  const mySeq = ++refreshSeq;
  currentAbort = new AbortController();
  const signal = currentAbort.signal;
  lastRequestStartedAt = nowMs();
  setLoading(true);
  pending = (async () => {
    try {
      const binsUsed = regionLen() <= 20000 ? regionLen() : state.bins;
      state._lastBinsUsed = binsUsed;
      setStatus(
        `${state.ref}:${comma(state.start)}-${comma(state.end)} • bins ${binsUsed}${binsUsed === regionLen() ? " (1/bp)" : ""}${statusSmoothHint()}`
      );
      const [region, genes] = await Promise.all([
        apiGet(makeRegionQuery(), signal),
        apiGet(makeGenesQuery(), signal),
      ]);
      if (mySeq !== refreshSeq) return;
      state.regionData = region;
      state.genes = genes.features || [];
      ensureTrackOrderFromRegion();
      ensureTrackGroups();
      normalizeTrackGroupsToOrder();
      applyTrackOrderToRegion();

      // Lock yMax on first successful load so it stays stable across navigation.
      if (state.yMaxLocked == null && typeof region.yMax === "number" && isFinite(region.yMax) && region.yMax > 0) {
        state.yMaxLocked = region.yMax;
      }

      pushUrlState();
      setStatus(
        `${state.ref}:${comma(state.start)}-${comma(state.end)} • bins ${binsUsed}${binsUsed === regionLen() ? " (1/bp)" : ""}${statusSmoothHint()}${state.spikyUi > 0 ? ` • sharp ${state.spikyUi}%` : ""}${state.perSampleScale ? " • per-sample scale" : ""} • scale ±${(getYMaxRaw() / state.yScale).toFixed(4)}`
      );
      draw();
    } catch (e) {
      if (e?.name === "AbortError") return;
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
      pending = null;
      if (refreshDirty) {
        refreshDirty = false;
        refresh();
      }
    }
  })();
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 50);
}

function refreshInteractive() {
  if (!startNewRequestIfNeeded()) return;
  refresh();
}

function drawAxis(ctx, w, h, y0) {
  ctx.strokeStyle = "rgba(15,23,42,0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(w, y0);
  ctx.stroke();
}

function drawSignal() {
  const canvas = el.signalCanvas;
  const data = state.regionData;
  const tracks = (data && data.tracks) || [];
  const groups = displayedTrackGroups();
  const lanes = groups
    .map((g) => g.map((k) => tracks.find((t) => trackKey(t) === k)).filter(Boolean))
    .filter((arr) => arr.length);

  // Dynamic lane height:
  //  • Measure what's actually above and below the signal canvas so we don't
  //    guess at offsets: topbar + status live above; gene canvas lives below.
  //  • Divide the remaining viewport height evenly across lanes → tracks fill screen.
  //  • Cap at maxLane so a single lane doesn't balloon when there are few tracks.
  //  • Floor at minLane for readability; canvas then exceeds viewport → page scrolls.
  const signalDocTop = canvas.getBoundingClientRect().top + window.scrollY;
  const geneCanvasH  = (el.geneCanvas.offsetHeight || 140) + 6; // +6 = CSS margin-top
  const viewportAvail = Math.max(300, window.innerHeight - signalDocTop - geneCanvasH - 16);
  const minLane = 160;
  const maxLane = 480;
  const n = Math.max(1, lanes.length);
  const laneH = clamp(Math.floor(viewportAvail / n), minLane, maxLane);
  canvas.style.height = `${n * laneH}px`;

  const { w, h } = resizeCanvasToCSSPixels(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  if (!data) return;

  const globalYMaxRaw = Math.max(1e-9, getYMaxRaw());
  const globalYMax = Math.max(1e-9, globalYMaxRaw / Math.max(1e-9, state.yScale));
  // yMax is reassigned per-lane when perSampleScale is on
  let yMax = globalYMax;
  const lenBp = regionLen();
  const perBase = (state._lastBinsUsed || 0) === lenBp;
  const rulerH = 34;
  const padTop = rulerH + 8;
  const padBottom = 6;
  const laneHeightPx = Math.floor((h - padTop - padBottom) / Math.max(1, lanes.length));

  // Overlay color palettes — optimised for the common 2-sample case.
  // Samples 0 and 1 get the biggest hue jump so they're unmistakable at a glance.
  // Alpha < 1 lets semi-transparent filled areas blend where signals overlap.
  const _overlayPlusColors = [
    "rgba(220,  38,  38, 0.80)",   // #0 vivid red
    "rgba(180,  15, 100, 0.74)",   // #1 deep magenta — large hue jump from red
    "rgba(234,  88,  12, 0.76)",   // #2 orange-red
    "rgba(127,  10,  34, 0.80)",   // #3 dark wine
    "rgba(248, 113, 113, 0.74)",   // #4 light coral
  ];
  const _overlayMinusColors = [
    "rgba( 37,  99, 235, 0.80)",   // #0 vivid blue
    "rgba( 13, 148, 136, 0.74)",   // #1 teal — large hue jump from blue
    "rgba( 99,  60, 200, 0.76)",   // #2 indigo-purple
    "rgba( 15,  40, 120, 0.80)",   // #3 deep navy
    "rgba( 96, 165, 250, 0.74)",   // #4 sky blue
  ];
  function overlayPlusColor(idx)  { return _overlayPlusColors[idx  % _overlayPlusColors.length]; }
  function overlayMinusColor(idx) { return _overlayMinusColors[idx % _overlayMinusColors.length]; }

  function drawOverlayLine(arr, ySign, y0, half, color, dash) {
    if (!arr || arr.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.setLineDash(Array.isArray(dash) ? dash : []);
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = (i / (arr.length - 1)) * w;
      const y = y0 + ySign * (arr[i] / yMax) * half;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Per-base bar rendering for overlay mode. Uses semi-transparent RGBA fill so
  // bars from multiple samples blend visually via canvas source-over compositing.
  function drawOverlayBars(arr, ySign, y0, half, color, bw, xPad, innerW) {
    if (!arr || !arr.length) return;
    ctx.fillStyle = color;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!v) continue;
      const x0 = i * bw + xPad;
      if (ySign < 0) {
        // plus strand → bars grow upward from baseline
        const y = y0 - (v / yMax) * half;
        const hBar = y0 - y;
        if (hBar <= 0) continue;
        ctx.fillRect(x0, y, innerW, hBar);
      } else {
        // minus strand → bars grow downward from baseline
        const y = y0 + (v / yMax) * half;
        const hBar = y - y0;
        if (hBar <= 0) continue;
        ctx.fillRect(x0, y0, innerW, hBar);
      }
    }
  }

  // ruler at top + get tick spacing
  const ruler = drawRuler(ctx, w, 0, rulerH);

  // vertical grid lines (major + minor) whose spacing tracks zoom level
  ctx.save();
  ctx.strokeStyle = "rgba(15,23,42,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const firstMinor = Math.ceil(state.start / ruler.minor) * ruler.minor;
  for (let bp = firstMinor; bp <= state.end; bp += ruler.minor) {
    const x = coordToX(bp, w);
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(15,23,42,0.10)";
  ctx.beginPath();
  const firstMajor = Math.ceil(state.start / ruler.step) * ruler.step;
  for (let bp = firstMajor; bp <= state.end; bp += ruler.step) {
    const x = coordToX(bp, w);
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.restore();

  for (let ti = 0; ti < lanes.length; ti++) {
    const laneTracks = lanes[ti];

    const laneTop = padTop + ti * laneHeightPx;
    const laneBottom = laneTop + laneHeightPx;
    const y0 = Math.round((laneTop + laneBottom) / 2);

    // Clip to lane so signal can't bleed into adjacent lanes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, laneTop, w, laneHeightPx);
    ctx.clip();

    // Per-lane yMax (overrides global when per-sample scale is on)
    if (state.perSampleScale) {
      let m = 0;
      for (const t of laneTracks) {
        for (const v of (t.plus || [])) { if (v > m) m = v; }
        for (const v of (t.minus || [])) { if (v > m) m = v; }
      }
      yMax = Math.max(1e-9, (m > 0 ? m : 1) / Math.max(1e-9, state.yScale));
    } else {
      yMax = globalYMax;
    }

    // lane separator + label
    ctx.strokeStyle = "rgba(15,23,42,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, laneTop);
    ctx.lineTo(w, laneTop);
    ctx.stroke();
    drawAxis(ctx, w, h, y0);

    ctx.font = "28px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(15,23,42,0.9)";
    ctx.globalAlpha = 1;
    let label = laneTracks[0].name || laneTracks[0].id;
    if (laneTracks.length > 1) {
      const names = laneTracks.map((tt) => tt.name || tt.id).filter(Boolean);
      const shown = names.slice(0, 2).join(" + ");
      const more = names.length > 2 ? ` +${names.length - 2} more` : "";
      label = `${shown}${more} (overlay)`;
    }
    ctx.fillText(label, 10, laneTop + 4);

    const half = Math.max(10, Math.floor(laneHeightPx / 2) - 14);

    // Y-axis ticks (drawn before signal so signal renders on top)
    {
      const ticks = [1.0, 0.5];
      ctx.save();
      ctx.font = "13px ui-sans-serif, system-ui";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      for (const frac of ticks) {
        const yPlus = y0 - frac * half;
        const yMinus = y0 + frac * half;
        const valLabel = formatSignalVal(frac * yMax);
        // faint horizontal guide lines
        ctx.strokeStyle = "rgba(15,23,42,0.07)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(55, yPlus); ctx.lineTo(w, yPlus);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(55, yMinus); ctx.lineTo(w, yMinus);
        ctx.stroke();
        ctx.setLineDash([]);
        // tick marks
        ctx.strokeStyle = "rgba(15,23,42,0.28)";
        ctx.beginPath();
        ctx.moveTo(0, yPlus); ctx.lineTo(7, yPlus);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, yMinus); ctx.lineTo(7, yMinus);
        ctx.stroke();
        // labels
        ctx.fillStyle = "rgba(71,85,105,0.80)";
        ctx.fillText(valLabel, 9, yPlus);
        ctx.fillText(`-${valLabel}`, 9, yMinus);
      }
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    // Strand colors (always): plus=red, minus=blue
    const plusColor = "#dc2626";
    const minusColor = "#2563eb";

    if (laneTracks.length > 1) {
      const usePerBase = perBase && lenBp <= 20000;

      if (usePerBase) {
        // Per-base bar overlay: each sample drawn as semi-transparent bars so they
        // visually blend via alpha compositing. Drawn back-to-front so sample 0 is
        // most prominent at the base.
        const n = Math.min(lenBp, ...(laneTracks.map(t =>
          Math.min((t.plus||[]).length || lenBp, (t.minus||[]).length || lenBp))));
        const bw = w / Math.max(1, n);
        const innerW = Math.max(1, bw * 0.72);
        const xPad = Math.max(0, (bw - innerW) / 2);
        for (let li = 0; li < laneTracks.length; li++) {
          const t = laneTracks[li];
          drawOverlayBars(t.plus  || [], -1, y0, half, overlayPlusColor(li),  bw, xPad, innerW);
          drawOverlayBars(t.minus || [], +1, y0, half, overlayMinusColor(li), bw, xPad, innerW);
        }
      } else {
        // Binned overlay: semi-transparent filled polygons, same style as single-track
        // but with alpha so the two areas blend visually where they overlap.
        for (let li = 0; li < laneTracks.length; li++) {
          const t = laneTracks[li];
          const plus  = t.plus  || [];
          const minus = t.minus || [];

          // plus area (upward)
          ctx.fillStyle = overlayPlusColor(li);
          ctx.beginPath();
          ctx.moveTo(0, y0);
          for (let i = 0; i < plus.length; i++) {
            const x = (i / Math.max(1, plus.length - 1)) * w;
            ctx.lineTo(x, y0 - (plus[i] / yMax) * half);
          }
          ctx.lineTo(w, y0);
          ctx.closePath();
          ctx.fill();

          // minus area (downward)
          ctx.fillStyle = overlayMinusColor(li);
          ctx.beginPath();
          ctx.moveTo(0, y0);
          for (let i = 0; i < minus.length; i++) {
            const x = (i / Math.max(1, minus.length - 1)) * w;
            ctx.lineTo(x, y0 + (minus[i] / yMax) * half);
          }
          ctx.lineTo(w, y0);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Legend: two color swatches (plus / minus) + sample name.
      const legendMax = 5;
      ctx.save();
      ctx.font = "16px ui-sans-serif, system-ui";
      ctx.textBaseline = "top";
      const startX = Math.max(10, w - 420);
      let yy = laneTop + 6;
      for (let li = 0; li < Math.min(legendMax, laneTracks.length); li++) {
        const tt = laneTracks[li];
        // Plus swatch
        ctx.fillStyle = overlayPlusColor(li);
        ctx.fillRect(startX, yy + 3, 14, 10);
        // Minus swatch
        ctx.fillStyle = overlayMinusColor(li);
        ctx.fillRect(startX + 16, yy + 3, 14, 10);
        // Name
        ctx.fillStyle = "rgba(15,23,42,0.85)";
        ctx.fillText(tt.name || tt.id, startX + 38, yy + 2);
        yy += 22;
      }
      if (laneTracks.length > legendMax) {
        ctx.fillStyle = "rgba(15,23,42,0.85)";
        ctx.fillText(`+${laneTracks.length - legendMax} more…`, startX + 38, yy + 2);
      }
      ctx.restore();
    } else if (perBase && lenBp <= 20000) {
      const t = laneTracks[0];
      const plus = t.plus || [];
      const minus = t.minus || [];
      // Per-base bar rendering: avoid visual "clumping" from interpolation.
      const n = Math.min(lenBp, plus.length, minus.length);
      const bw = w / Math.max(1, n);
      const innerW = Math.max(1, bw * 0.72); // thinner bars look less "boxy"
      const xPad = Math.max(0, (bw - innerW) / 2);

      // plus bars
      ctx.fillStyle = plusColor;
      for (let i = 0; i < n; i++) {
        const v = plus[i];
        if (!v) continue;
        const x0 = i * bw + xPad;
        const y = y0 - (v / yMax) * half;
        const hBar = y0 - y;
        if (hBar <= 0) continue;
        ctx.fillRect(x0, y, innerW, hBar);
      }

      // minus bars
      ctx.fillStyle = minusColor;
      for (let i = 0; i < n; i++) {
        const v = minus[i];
        if (!v) continue;
        const x0 = i * bw + xPad;
        const y = y0 + (v / yMax) * half;
        const hBar = y - y0;
        if (hBar <= 0) continue;
        ctx.fillRect(x0, y0, innerW, hBar);
      }
    } else {
      const t = laneTracks[0];
      const plus = t.plus || [];
      const minus = t.minus || [];
      // binned/summary rendering: filled polygon is cheaper and looks smooth.
      // plus area (opaque)
      ctx.fillStyle = plusColor;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let i = 0; i < plus.length; i++) {
        const x = (i / (plus.length - 1)) * w;
        const y = y0 - (plus[i] / yMax) * half;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, y0);
      ctx.closePath();
      ctx.fill();

      // minus area (values are positive magnitudes; draw downward)
      ctx.fillStyle = minusColor;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let i = 0; i < minus.length; i++) {
        const x = (i / (minus.length - 1)) * w;
        const y = y0 + (minus[i] / yMax) * half;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, y0);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // crosshair (draw last so it's on top)
  if (state.hover && state.hover.active) {
    ctx.save();
    ctx.strokeStyle = "rgba(15,23,42,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(state.hover.xPx, 0);
    ctx.lineTo(state.hover.xPx, h);
    ctx.stroke();
    ctx.restore();
  }

  // selection overlay
  if (state.selecting) {
    const rect = canvas.getBoundingClientRect();
    const r = selectionRange();
    if (r) {
      const x1 = clamp((r.left - rect.left) / rect.width, 0, 1) * w;
      const x2 = clamp((r.right - rect.left) / rect.width, 0, 1) * w;
      ctx.save();
      ctx.fillStyle = "rgba(2,132,199,0.12)";
      ctx.strokeStyle = "rgba(2,132,199,0.55)";
      ctx.lineWidth = 2;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      ctx.strokeRect(x1, 0, Math.max(1, x2 - x1), h);
      ctx.restore();
    }
  }
}

function drawGenes() {
  const canvas = el.geneCanvas;
  canvas.style.height = `90px`;
  const { w, h } = resizeCanvasToCSSPixels(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const features = state.genes || [];
  if (!features.length) {
    ctx.fillStyle = "rgba(71,85,105,0.9)";
    ctx.font = "18px ui-sans-serif, system-ui";
    ctx.fillText("No genes in region", 10, 20);
    return;
  }

  const lanes = 2;
  const laneH = Math.floor((h - 16) / lanes);
  const yBase = 10;

  ctx.font = "18px ui-sans-serif, system-ui";
  ctx.textBaseline = "middle";

  let lane = 0;
  for (const g of features.slice(0, 200)) {
    const x1 = coordToX(g.start, w);
    const x2 = coordToX(g.end, w);
    if (x2 < 0 || x1 > w) continue;

    const y = yBase + lane * laneH + Math.floor(laneH / 2);
    lane = (lane + 1) % lanes;

    // Gene colors should match signal convention:
    // sense (+) = red, antisense (-) = blue
    const isPlus = g.strand !== "-";
    const color = isPlus ? "rgba(220,38,38,0.95)" : "rgba(37,99,235,0.95)";

    // intron backbone (thin)
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();

    // exons (thick boxes) if provided by backend (GTF exon features)
    const exons = Array.isArray(g.exons) ? g.exons : null;
    if (exons && exons.length) {
      ctx.fillStyle = color;
      const exonH = 10;
      for (const ex of exons) {
        const s = ex[0];
        const e = ex[1];
        if (typeof s !== "number" || typeof e !== "number" || e <= s) continue;
        const ex1 = coordToX(s, w);
        const ex2 = coordToX(e, w);
        const xx1 = clamp(ex1, -50, w + 50);
        const xx2 = clamp(ex2, -50, w + 50);
        const ww = Math.max(1, xx2 - xx1);
        ctx.fillRect(xx1, y - exonH / 2, ww, exonH);
      }
    }

    // direction chevrons
    const step = 22;
    ctx.lineWidth = 1.5;
    for (let x = x1 + 6; x < x2 - 6; x += step) {
      ctx.beginPath();
      if (isPlus) {
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 5);
      } else {
        ctx.moveTo(x + 6, y - 5);
        ctx.lineTo(x, y);
        ctx.lineTo(x + 6, y + 5);
      }
      ctx.stroke();
    }

    // label (only if space)
    const label = g.name || g.id || "";
    if (label) {
      const pad = 4;
      const labelX = clamp(x1, 0, w - 10) + pad;
      ctx.fillStyle = "rgba(15,23,42,0.9)";
      ctx.fillText(label, labelX, y - Math.floor(laneH / 2) + 10);
    }
  }

  // crosshair overlay for gene canvas
  if (state.hover && state.hover.active) {
    ctx.save();
    ctx.strokeStyle = "rgba(15,23,42,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(state.hover.xPx, 0);
    ctx.lineTo(state.hover.xPx, h);
    ctx.stroke();
    ctx.restore();
  }

  // selection overlay
  if (state.selecting) {
    const rect = canvas.getBoundingClientRect();
    const r = selectionRange();
    if (r) {
      const x1 = clamp((r.left - rect.left) / rect.width, 0, 1) * w;
      const x2 = clamp((r.right - rect.left) / rect.width, 0, 1) * w;
      ctx.save();
      ctx.fillStyle = "rgba(2,132,199,0.12)";
      ctx.strokeStyle = "rgba(2,132,199,0.55)";
      ctx.lineWidth = 2;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      ctx.strokeRect(x1, 0, Math.max(1, x2 - x1), h);
      ctx.restore();
    }
  }
}

function draw() {
  drawSignal();
  drawGenes();
}

state.hover = { active: false, xPx: 0, coord: 0, bin: 0 };
state.selecting = false;
state.selStartClientX = 0;
state.selCurClientX = 0;

function selectionRange() {
  if (!state.selecting) return null;
  const a = state.selStartClientX;
  const b = state.selCurClientX;
  return { left: Math.min(a, b), right: Math.max(a, b) };
}

function showTooltip(clientX, clientY, lines) {
  if (!el.tooltip) return;
  el.tooltip.classList.remove("hidden");
  el.tooltip.textContent = lines.join("  •  ");
  // position within viewer
  const viewer = el.signalCanvas.closest(".viewer");
  const vr = viewer.getBoundingClientRect();
  const pad = 10;
  let x = clientX - vr.left + 14;
  let y = clientY - vr.top + 14;
  // clamp inside viewer
  const tw = el.tooltip.offsetWidth || 260;
  const th = el.tooltip.offsetHeight || 34;
  x = clamp(x, pad, vr.width - tw - pad);
  y = clamp(y, pad, vr.height - th - pad);
  el.tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function hideTooltip() {
  el.tooltip?.classList.add("hidden");
}

function updateHover(clientX, clientY) {
  if (!state.regionData) return;
  const rect = el.signalCanvas.getBoundingClientRect();
  const xPx = clamp(clientX - rect.left, 0, rect.width);
  const coord = coordFromClientX(clientX);
  const bin = binIndexFromClientX(clientX);
  state.hover.active = true;
  // map css px -> device px for drawing
  const dpr = window.devicePixelRatio || 1;
  state.hover.xPx = xPx * dpr;
  state.hover.coord = coord;
  state.hover.bin = bin;

  // choose which track lane we're hovering based on Y position
  const tracks = state.regionData.tracks || [];
  const groups = displayedTrackGroups();
  const lanes = groups
    .map((g) => g.map((k) => tracks.find((t) => trackKey(t) === k)).filter(Boolean))
    .filter((arr) => arr.length);
  const canvas = el.signalCanvas;
  const cr = canvas.getBoundingClientRect();
  const yCss = clamp(clientY - cr.top, 0, cr.height);
  const rulerH = 34;
  const padTop = rulerH + 8;
  const padBottom = 6;
  const laneArea = Math.max(1, cr.height - padTop - padBottom);
  const laneIdx = lanes.length ? clamp(Math.floor(((yCss - padTop) / laneArea) * lanes.length), 0, lanes.length - 1) : 0;
  const lane = lanes[laneIdx];
  if (!lane || !lane.length) {
    showTooltip(clientX, clientY, [`${state.ref}:${comma(coord)}`]);
    draw();
    return;
  }
  const lines = [`${state.ref}:${comma(coord)}`];
  for (const t of lane) {
    const plus = t.plus || [];
    const minus = t.minus || [];
    const p = plus[bin] ?? 0;
    const m = minus[bin] ?? 0;
    lines.push(`${t.name || t.id}  +${p.toFixed(4)}  -${m.toFixed(4)}`);
  }
  showTooltip(clientX, clientY, lines);
  draw();
}

function clearHover() {
  if (!state.hover.active) return;
  state.hover.active = false;
  hideTooltip();
  draw();
}

function zoomAt(px, factor) {
  const canvas = el.signalCanvas;
  const rect = canvas.getBoundingClientRect();
  const rel = clamp((px - rect.left) / rect.width, 0, 1);
  const len = regionLen();
  // Quantize zoom to whole-percent steps for stability/performance.
  const desiredLen = clamp(Math.round(len * factor), 50, 50_000_000);
  const pct = Math.round(zoomValueFromLen(desiredLen)); // 0..100
  const newLen = lenFromZoomValue(pct);
  const center = Math.round(state.start + rel * len);
  const newStart = Math.max(0, Math.round(center - rel * newLen));
  const newEnd = newStart + newLen;
  state.start = newStart;
  state.end = newEnd;
  scheduleRefresh();
}

let wheelAccum = 0;
let wheelAnchorX = 0;
let wheelRaf = null;
function scheduleWheelZoom(clientX, deltaY) {
  wheelAnchorX = clientX;
  // Trackpads can send small continuous deltas; accumulate for smooth zoom.
  wheelAccum += deltaY;
  if (wheelRaf) return;
  wheelRaf = window.requestAnimationFrame(() => {
    const d = wheelAccum;
    wheelAccum = 0;
    wheelRaf = null;
    // Convert wheel delta into percent-zoom steps (discrete).
    const curPct = Math.round(zoomValueFromLen(regionLen()));
    const deltaPct = clamp(Math.round(d / 120) * 2, -10, 10); // ~2% per wheel notch
    const nextPct = clamp(curPct + deltaPct, 0, 100);
    const canvas = el.signalCanvas;
    const rect = canvas.getBoundingClientRect();
    const rel = clamp((wheelAnchorX - rect.left) / rect.width, 0, 1);
    const len = regionLen();
    const newLen = lenFromZoomValue(nextPct);
    const center = Math.round(state.start + rel * len);
    const newStart = Math.max(0, Math.round(center - rel * newLen));
    state.start = newStart;
    state.end = newStart + newLen;
    scheduleRefresh();
  });
}

function panBy(dxPixels) {
  const canvas = el.signalCanvas;
  const rect = canvas.getBoundingClientRect();
  const len = regionLen();
  const delta = Math.round((dxPixels / rect.width) * len);
  state.start = Math.max(0, state.start - delta);
  state.end = Math.max(state.start + 1, state.end - delta);
  scheduleRefresh();
}

// interactions
el.signalCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  scheduleWheelZoom(e.clientX, e.deltaY);
});

el.geneCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  scheduleWheelZoom(e.clientX, e.deltaY);
});

el.signalCanvas.addEventListener("mousemove", (e) => {
  if (state.dragging || state.selecting) return;
  updateHover(e.clientX, e.clientY);
});
el.geneCanvas.addEventListener("mousemove", (e) => {
  if (state.dragging || state.selecting) return;
  updateHover(e.clientX, e.clientY);
});
el.signalCanvas.addEventListener("mouseleave", clearHover);
el.geneCanvas.addEventListener("mouseleave", clearHover);

el.signalCanvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (e.shiftKey) {
    state.selecting = true;
    state.selStartClientX = e.clientX;
    state.selCurClientX = e.clientX;
    clearHover();
    draw();
    return;
  }
  state.dragging = true;
  state.dragStartX = e.clientX;
  state.dragStartStart = state.start;
  state.dragStartEnd = state.end;
});

// also allow drag-to-pan when starting on the gene track
el.geneCanvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (e.shiftKey) {
    state.selecting = true;
    state.selStartClientX = e.clientX;
    state.selCurClientX = e.clientX;
    clearHover();
    draw();
    return;
  }
  state.dragging = true;
  state.dragStartX = e.clientX;
  state.dragStartStart = state.start;
  state.dragStartEnd = state.end;
});

window.addEventListener("mousemove", (e) => {
  if (state.selecting) {
    state.selCurClientX = e.clientX;
    draw();
    return;
  }
  if (!state.dragging) return;
  const dx = e.clientX - state.dragStartX;
  const canvas = el.signalCanvas;
  const rect = canvas.getBoundingClientRect();
  const len = state.dragStartEnd - state.dragStartStart;
  const delta = Math.round((dx / rect.width) * len);
  state.start = Math.max(0, state.dragStartStart - delta);
  state.end = Math.max(state.start + 1, state.dragStartEnd - delta);
  // While dragging, keep the plot following the mouse with controlled rate.
  refreshInteractive();
});

window.addEventListener("mouseup", () => {
  if (state.selecting) {
    const r = selectionRange();
    state.selecting = false;
    if (r) {
      const a = coordFromClientX(r.left);
      const b = coordFromClientX(r.right);
      const s = Math.min(a, b);
      const e = Math.max(a, b);
      if (e - s >= 5) {
        state.start = Math.max(0, s);
        state.end = Math.max(state.start + 1, e);
        scheduleRefresh();
      } else {
        draw();
      }
    }
    return;
  }
  if (!state.dragging) return;
  state.dragging = false;
  scheduleRefresh();
});

el.searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = el.searchInput.value.trim();
  if (!q) return;
  clearGeneSuggestions();
  try {
    const out = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
    state.ref = out.ref;
    state.start = out.start;
    state.end = out.end;
    el.searchInput.value = "";
    refresh();
  } catch (err) {
    setStatus(`Search error: ${err.message}`);
  }
});

el.searchInput.addEventListener("input", () => {
  const q = el.searchInput.value.trim();
  if (!isGenePrefixQuery(q) || q.length < 1) {
    clearGeneSuggestions();
    return;
  }

  if (suggestTimer) window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(async () => {
    try {
      if (currentSuggestAbort) currentSuggestAbort.abort();
      currentSuggestAbort = new AbortController();
      const data = await apiSuggest(q, currentSuggestAbort.signal);
      const suggestions = data?.suggestions || [];
      if (!el.geneSuggestList) return;
      el.geneSuggestList.innerHTML = "";
      for (const s of suggestions.slice(0, 20)) {
        const opt = document.createElement("option");
        const value = s.value ?? s.label ?? "";
        const label = s.label ?? value;
        if (!value) continue;
        opt.value = value;
        opt.label = label;
        el.geneSuggestList.appendChild(opt);
      }
    } catch (e) {
      // ignore aborts/errors; suggestions are best-effort
    }
  }, 120);
});

el.searchInput.addEventListener("blur", () => {
  // Small delay to allow clicks on suggestions in some browsers.
  window.setTimeout(() => clearGeneSuggestions(), 150);
});

function applyYScale(factor) {
  state.yScale = clamp(state.yScale * factor, 0.1, 10);
  if (state.regionData) {
    setStatus(
      `${state.ref}:${comma(state.start)}-${comma(state.end)} • bins ${state._lastBinsUsed || state.bins}${
        (state._lastBinsUsed || state.bins) === regionLen() ? " (1/bp)" : ""
      } • scale ±${(getYMaxRaw() / state.yScale).toFixed(4)}`
    );
    draw();
  } else {
    refresh();
  }
}

function adjustSmooth(deltaUi) {
  const next = clamp(state.smoothUi + deltaUi, 0, 100);
  if (next === state.smoothUi) return;
  state.smoothUi = next;
  scheduleRefresh();
}

function adjustBins(delta) {
  const next = clamp(state.bins + delta, 200, 8000);
  if (next === state.bins) return;
  state.bins = next;
  scheduleRefresh();
}

function adjustSpiky(deltaUi) {
  const next = clamp(state.spikyUi + deltaUi, 0, 100);
  if (next === state.spikyUi) return;
  state.spikyUi = next;
  scheduleRefresh();
}

function togglePerSampleScale() {
  state.perSampleScale = !state.perSampleScale;
  // No API call needed — rescaling is purely client-side.
  draw();
}

function exportPng() {
  // Composite signal + gene canvases onto an offscreen canvas and download.
  const sc = el.signalCanvas;
  const gc = el.geneCanvas;
  const W = Math.max(sc.width, gc.width);
  const H = sc.height + gc.height;
  const off = document.createElement("canvas");
  off.width = W;
  off.height = H;
  const ctx = off.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(sc, 0, 0);
  ctx.drawImage(gc, 0, sc.height);
  off.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proBrow_${state.ref}_${state.start}-${state.end}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA";
  if (e.key === "Escape") {
    setHelpOpen(false);
    return;
  }
  // Avoid opening help while the user is typing in the search box.
  if (typing && (e.key === "h" || e.key === "?")) return;
  if (e.key === "?" || e.key === "h") {
    setHelpOpen(el.helpOverlay?.classList.contains("hidden"));
    e.preventDefault();
    return;
  }
  if (e.key === "g") {
    el.searchInput.focus();
    e.preventDefault();
    return;
  }
  if (typing) return;
  if (e.key === "+" || e.key === "=") {
    const rect = el.signalCanvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, 0.7);
  } else if (e.key === "-") {
    const rect = el.signalCanvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, 1.35);
  } else if (e.key === "ArrowLeft") {
    panBy(100);
  } else if (e.key === "ArrowRight") {
    panBy(-100);
  } else if (e.key === "]") {
    applyYScale(1.25);
    e.preventDefault();
  } else if (e.key === "[") {
    applyYScale(1 / 1.25);
    e.preventDefault();
  } else if (e.key === "s") {
    // lower smoothing (more spiky)
    adjustSmooth(-10);
    e.preventDefault();
  } else if (e.key === "S") {
    // higher smoothing
    adjustSmooth(+10);
    e.preventDefault();
  } else if (e.key === "k") {
    adjustSpiky(-10);
    e.preventDefault();
  } else if (e.key === "K") {
    adjustSpiky(+10);
    e.preventDefault();
  } else if (e.key === "p") {
    togglePerSampleScale();
    e.preventDefault();
  } else if (e.key === "e") {
    exportPng();
    e.preventDefault();
  } else if (e.key === "b") {
    adjustBins(-200);
    e.preventDefault();
  } else if (e.key === "B") {
    adjustBins(+200);
    e.preventDefault();
  } else if (e.key === "a") {
    // Re-autoscale to current region (updates locked yMax).
    const v = state.regionData?.yMax;
    if (typeof v === "number" && isFinite(v) && v > 0) {
      state.yMaxLocked = v;
      setStatus(
        `${state.ref}:${comma(state.start)}-${comma(state.end)} • bins ${state._lastBinsUsed || state.bins}${
          (state._lastBinsUsed || state.bins) === regionLen() ? " (1/bp)" : ""
        } • scale ±${(getYMaxRaw() / state.yScale).toFixed(4)}`
      );
      draw();
    } else {
      refresh();
    }
    e.preventDefault();
  }
});

el.helpButton?.addEventListener("click", () =>
  setHelpOpen(el.helpOverlay?.classList.contains("hidden"))
);

el.tracksButton?.addEventListener("click", () =>
  setTracksOpen(el.tracksOverlay?.classList.contains("hidden"))
);

el.tracksOverlay?.addEventListener("click", (e) => {
  if (e.target === el.tracksOverlay) setTracksOpen(false);
});
el.tracksClose?.addEventListener("click", () => setTracksOpen(false));

el.helpOverlay?.addEventListener("click", (e) => {
  if (e.target === el.helpOverlay) setHelpOpen(false);
});
el.helpClose?.addEventListener("click", () => setHelpOpen(false));

window.addEventListener("resize", draw);

el.exportButton?.addEventListener("click", exportPng);

await loadConfig();
parseUrlState(); // override server defaults with URL hash if present
renderHelp();
refresh();

