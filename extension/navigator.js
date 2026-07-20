/* Tour Navigator — content script.
 *
 * Draws a guidepost bar over the player: the stage elevation profile plotted
 * against RECORDING time (not distance), with markers for the things worth
 * navigating to. Clicking anywhere on it seeks.
 *
 * The one genuinely hard problem is the clock. Our data is in UTC race time;
 * the player knows only "seconds into this recording". Those differ by an
 * unknown offset (pre-race build-up) AND an unknown rate (ad breaks, pauses,
 * a broadcast that joins late). So the viewer calibrates with two anchors:
 * pause on a moment we have a timestamp for, pick it, repeat once more later.
 * Two points give offset and rate, which is enough to place everything else.
 *
 * This only reads video.currentTime and sets it to seek. It does not touch,
 * capture or download any stream content.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "tourNavigatorAnchors";
  const CATEGORIES = {
    crash:           { label: "Crashes",    color: "#e5484d", on: true },
    breakaway_start: { label: "Attacks",    color: "#f5a524", on: true },
    breakaway_end:   { label: "Caught",     color: "#8b7cf6", on: true },
    scenic:          { label: "Scenery",    color: "#30a46c", on: true },
    history:         { label: "History",    color: "#0091ff", on: true },
    route:           { label: "Sprint/Fin", color: "#e0e0e0", on: true },
    stat:            { label: "Stats",      color: "#8b8b8b", on: false },
  };

  let bundle = null;
  let video = null;
  let anchors = [];           // [{ tUtcMs, videoSec, label }]
  let root = null;
  const enabled = Object.fromEntries(
    Object.entries(CATEGORIES).map(([k, v]) => [k, v.on]));

  // ---------------------------------------------------------------- clock

  /** Map race UTC (ms) -> seconds into the recording, from the anchors.
   *  0 anchors: unusable. 1 anchor: assume real time (rate 1.0). 2+: fit both
   *  offset and rate, which absorbs ad breaks and a late broadcast join. */
  function utcToVideo(tUtcMs) {
    if (anchors.length === 0) return null;
    if (anchors.length === 1) {
      const a = anchors[0];
      return a.videoSec + (tUtcMs - a.tUtcMs) / 1000;
    }
    const [a, b] = [anchors[0], anchors[anchors.length - 1]];
    const spanMs = b.tUtcMs - a.tUtcMs;
    if (spanMs === 0) return a.videoSec;
    const rate = (b.videoSec - a.videoSec) / (spanMs / 1000);
    return a.videoSec + ((tUtcMs - a.tUtcMs) / 1000) * rate;
  }

  function videoToUtc(sec) {
    if (anchors.length === 0) return null;
    if (anchors.length === 1) {
      const a = anchors[0];
      return a.tUtcMs + (sec - a.videoSec) * 1000;
    }
    const [a, b] = [anchors[0], anchors[anchors.length - 1]];
    const rate = (b.videoSec - a.videoSec) / ((b.tUtcMs - a.tUtcMs) / 1000);
    if (!rate) return a.tUtcMs;
    return a.tUtcMs + ((sec - a.videoSec) / rate) * 1000;
  }

  const fmt = (sec) => {
    if (sec == null || !isFinite(sec)) return "--:--";
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
             : `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  // ---------------------------------------------------------------- render

  function profilePath(width, height) {
    const pts = bundle.profile.filter((p) => p.t);
    if (!pts.length || !video?.duration) return { d: "", pts: [] };
    const alts = pts.map((p) => p.alt);
    const loA = Math.min(...alts), hiA = Math.max(...alts);
    const rangeA = Math.max(1, hiA - loA);

    const xy = [];
    for (const p of pts) {
      const sec = utcToVideo(Date.parse(p.t));
      if (sec == null || sec < 0 || sec > video.duration) continue;
      xy.push([
        (sec / video.duration) * width,
        height - ((p.alt - loA) / rangeA) * (height - 4) - 2,
      ]);
    }
    if (!xy.length) return { d: "", pts: [] };
    let d = `M ${xy[0][0].toFixed(1)} ${height} L `;
    d += xy.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
    d += ` L ${xy[xy.length - 1][0].toFixed(1)} ${height} Z`;
    return { d, pts: xy, loA, hiA };
  }

  function render() {
    if (!root || !bundle || !video?.duration) return;
    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const height = 54;

    const { d, loA, hiA } = profilePath(width, height);
    const needsAnchors = anchors.length === 0;

    const markers = [];
    if (!needsAnchors) {
      for (const g of bundle.guideposts) {
        if (!enabled[g.category]) continue;
        const sec = utcToVideo(Date.parse(g.t_utc));
        if (sec == null || sec < 0 || sec > video.duration) continue;
        const x = (sec / video.duration) * width;
        const c = CATEGORIES[g.category]?.color || "#fff";
        markers.push(
          `<div class="tn-marker" style="left:${x.toFixed(1)}px;background:${c}"
                data-sec="${sec.toFixed(1)}"
                title="${fmt(sec)} — ${escapeHtml(g.label)}"></div>`);
      }
    }

    // Intensity heat strip: darker = more happening.
    let heat = "";
    if (!needsAnchors && bundle.intensity?.length) {
      for (const s of bundle.intensity) {
        const sec = utcToVideo(Date.parse(s.t_utc));
        if (sec == null || sec < 0 || sec > video.duration) continue;
        const x = (sec / video.duration) * width;
        const w = Math.max(1, (s.window_min * 60 / video.duration) * width);
        heat += `<div class="tn-heat" style="left:${x.toFixed(1)}px;width:${w.toFixed(1)}px;
                  opacity:${(s.normalised * 0.75).toFixed(2)}"></div>`;
      }
    }

    const playX = (video.currentTime / video.duration) * width;

    bar.innerHTML = `
      <div class="tn-heatwrap">${heat}</div>
      <svg class="tn-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <path d="${d}" class="tn-profile"/>
      </svg>
      <div class="tn-markers">${markers.join("")}</div>
      <div class="tn-playhead" style="left:${playX.toFixed(1)}px"></div>
      ${needsAnchors ? `<div class="tn-needcal">Set two anchors below to place guideposts →</div>` : ""}
      ${d ? `<span class="tn-alt tn-alt-hi">${Math.round(hiA)}m</span>
             <span class="tn-alt tn-alt-lo">${Math.round(loA)}m</span>` : ""}
    `;

    bar.querySelectorAll(".tn-marker").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        video.currentTime = parseFloat(el.dataset.sec);
      });
    });

    const utcNow = videoToUtc(video.currentTime);
    root.querySelector(".tn-clock").textContent = utcNow
      ? `race ${new Date(utcNow).toISOString().slice(11, 19)}Z · rec ${fmt(video.currentTime)}`
      : `rec ${fmt(video.currentTime)} · not calibrated`;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ ui

  function buildUi() {
    root = document.createElement("div");
    root.className = "tn-root";
    root.innerHTML = `
      <div class="tn-head">
        <strong>Tour Navigator</strong>
        <span class="tn-stage"></span>
        <span class="tn-clock"></span>
        <button class="tn-collapse" title="Hide">–</button>
      </div>
      <div class="tn-bar"></div>
      <div class="tn-controls">
        <div class="tn-filters"></div>
        <div class="tn-anchors">
          <select class="tn-anchor-pick"><option value="">pick a moment…</option></select>
          <button class="tn-anchor-add">Anchor here</button>
          <button class="tn-anchor-clear" title="Clear anchors">reset</button>
          <span class="tn-anchor-state"></span>
        </div>
      </div>`;
    document.body.appendChild(root);

    const filters = root.querySelector(".tn-filters");
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      const id = `tn-f-${key}`;
      const el = document.createElement("label");
      el.className = "tn-filter";
      el.innerHTML = `<input type="checkbox" id="${id}" ${enabled[key] ? "checked" : ""}>
        <span class="tn-dot" style="background:${meta.color}"></span>${meta.label}`;
      el.querySelector("input").addEventListener("change", (e) => {
        enabled[key] = e.target.checked;
        render();
      });
      filters.appendChild(el);
    }

    root.querySelector(".tn-collapse").addEventListener("click", () => {
      root.classList.toggle("tn-collapsed");
    });
    root.querySelector(".tn-bar").addEventListener("click", (ev) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      if (video?.duration) {
        video.currentTime = ((ev.clientX - rect.left) / rect.width) * video.duration;
      }
    });
    root.querySelector(".tn-anchor-add").addEventListener("click", addAnchor);
    root.querySelector(".tn-anchor-clear").addEventListener("click", () => {
      anchors = [];
      persist();
      refreshAnchorState();
      render();
    });
  }

  function populatePicker() {
    const sel = root.querySelector(".tn-anchor-pick");
    // Distinct, easy-to-spot-on-screen moments make the best anchors.
    const candidates = bundle.guideposts.filter(
      (g) => g.category === "route" || g.category === "scenic" ||
             g.category === "crash" || g.category === "breakaway_end");
    for (const g of candidates) {
      const o = document.createElement("option");
      o.value = g.t_utc;
      o.textContent = `${g.t_utc.slice(11, 16)}Z — ${g.label}`.slice(0, 70);
      sel.appendChild(o);
    }
  }

  function addAnchor() {
    const sel = root.querySelector(".tn-anchor-pick");
    if (!sel.value || !video) return;
    anchors.push({
      tUtcMs: Date.parse(sel.value),
      videoSec: video.currentTime,
      label: sel.options[sel.selectedIndex].textContent,
    });
    anchors.sort((a, b) => a.tUtcMs - b.tUtcMs);
    if (anchors.length > 2) anchors = [anchors[0], anchors[anchors.length - 1]];
    persist();
    refreshAnchorState();
    render();
  }

  function refreshAnchorState() {
    const el = root.querySelector(".tn-anchor-state");
    if (anchors.length === 0) el.textContent = "no anchors — guideposts hidden";
    else if (anchors.length === 1) el.textContent = "1 anchor (assuming real-time); add a 2nd";
    else {
      const [a, b] = [anchors[0], anchors[anchors.length - 1]];
      const rate = (b.videoSec - a.videoSec) / ((b.tUtcMs - a.tUtcMs) / 1000);
      el.textContent = `calibrated · ${rate.toFixed(3)}× real time`;
    }
  }

  function persist() {
    try {
      chrome.storage?.local?.set({ [STORAGE_KEY + ":" + stageKey()]: anchors });
    } catch (_) { /* storage is a convenience, not a requirement */ }
  }

  function restore(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY + ":" + stageKey()], (r) => {
        anchors = r?.[STORAGE_KEY + ":" + stageKey()] || [];
        cb();
      });
    } catch (_) { cb(); }
  }

  const stageKey = () => `stage-${bundle?.stage?.stage ?? "?"}`;

  // --------------------------------------------------------------- bootstrap

  function findVideo() {
    const vids = [...document.querySelectorAll("video")]
      .filter((v) => v.duration && isFinite(v.duration) && v.duration > 600);
    return vids[0] || null;
  }

  async function loadBundle() {
    // Which stage is on screen isn't knowable from the Peacock URL, so the
    // bundle is selected by what's shipped; swap the file to change stages.
    const url = chrome.runtime.getURL("data/stage.json");
    const res = await fetch(url);
    return res.json();
  }

  async function start() {
    try {
      bundle = await loadBundle();
    } catch (e) {
      console.warn("[TourNavigator] could not load stage bundle", e);
      return;
    }
    buildUi();
    populatePicker();
    const s = bundle.stage || {};
    root.querySelector(".tn-stage").textContent =
      `Stage ${s.stage ?? "?"} · ${s.departure ?? ""} → ${s.arrival ?? ""} · ${s.length_km ?? "?"}km`;
    restore(() => { refreshAnchorState(); render(); });

    setInterval(() => {
      const v = findVideo();
      if (v && v !== video) { video = v; render(); }
      else if (video) render();
    }, 500);
    window.addEventListener("resize", render);
  }

  start();
})();
