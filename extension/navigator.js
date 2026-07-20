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
  let bundle_index = null;
  let bundle_selection_ok = false;
  let video = null;
  let anchors = [];           // [{ tUtcMs, videoSec, label }]
  let root = null;
  const enabled = Object.fromEntries(
    Object.entries(CATEGORIES).map(([k, v]) => [k, v.on]));

  // ---------------------------------------------------------------- clock

  /** Map race UTC (ms) -> seconds into the recording, from the anchors.
   *  0 anchors: unusable. 1 anchor: assume real time (rate 1.0). 2+: fit both
   *  offset and rate, which absorbs ad breaks and a late broadcast join. */
  /* Calibration is a single explicit transform:
   *     videoSec = offsetSec + rate * (tUtcMs - refMs)/1000
   * Anchors are one way to derive it; dragging the bar is another. Keeping it
   * as one object means a manual nudge is exact and inspectable rather than a
   * fudge layered on top of an anchor pair. */
  let cal = null;   // {refMs, offsetSec, rate}
  let alignMode = false;

  function calFromAnchors() {
    if (!anchors.length) return null;
    const a = anchors[0];
    if (anchors.length === 1) return { refMs: a.tUtcMs, offsetSec: a.videoSec, rate: 1 };
    const b = anchors[anchors.length - 1];
    const spanSec = (b.tUtcMs - a.tUtcMs) / 1000;
    const rate = spanSec ? (b.videoSec - a.videoSec) / spanSec : 1;
    return { refMs: a.tUtcMs, offsetSec: a.videoSec, rate };
  }

  function utcToVideo(tUtcMs) {
    if (!cal) return null;
    return cal.offsetSec + cal.rate * (tUtcMs - cal.refMs) / 1000;
  }

  function videoToUtc(sec) {
    if (!cal || !cal.rate) return null;
    return cal.refMs + ((sec - cal.offsetSec) / cal.rate) * 1000;
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

    // Estimated points (GPS came online late, so the head is spanned from the
    // known start time) are drawn as a separate, dimmer shape. The whole stage
    // is shown, but "we saw this" and "we inferred this" stay distinguishable.
    const xy = [], xyEst = [];
    for (const p of pts) {
      const sec = utcToVideo(Date.parse(p.t));
      if (sec == null || sec < 0 || sec > video.duration) continue;
      const pt = [
        (sec / video.duration) * width,
        height - ((p.alt - loA) / rangeA) * (height - 4) - 2,
      ];
      (p.est ? xyEst : xy).push(pt);
      // Bridge the seam so the two shapes meet instead of leaving a notch.
      if (p.est && xyEst.length && xy.length === 0) { /* still in the head */ }
    }
    if (xyEst.length && xy.length) xyEst.push(xy[0]);
    const area = (arr) => {
      if (arr.length < 2) return "";
      let s = `M ${arr[0][0].toFixed(1)} ${height} L `;
      s += arr.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
      s += ` L ${arr[arr.length - 1][0].toFixed(1)} ${height} Z`;
      return s;
    };
    if (!xy.length && !xyEst.length) return { d: "", dEst: "", pts: [] };
    return { d: area(xy), dEst: area(xyEst), pts: xy, loA, hiA };
  }

  function render() {
    if (!root || !bundle || !video?.duration) return;
    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const height = 54;

    const { d, dEst, loA, hiA } = profilePath(width, height);
    const needsAnchors = !cal;

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
        <path d="${dEst || ""}" class="tn-profile tn-profile-est"/>
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
        <select class="tn-stage-pick" title="Which stage this recording is"></select>
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
          <button class="tn-align" title="Drag the profile to line it up with what is on screen">Align</button>
          <button class="tn-auto">Auto-calibrate</button>
          <button class="tn-probe" title="Report what this player exposes">Diagnose</button>
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
    const bar = root.querySelector(".tn-bar");

    bar.addEventListener("click", (ev) => {
      if (alignMode) return;                 // in align mode a click is a drag
      const rect = ev.currentTarget.getBoundingClientRect();
      if (video?.duration) {
        video.currentTime = ((ev.clientX - rect.left) / rect.width) * video.duration;
      }
    });

    /* Align mode: drag the profile until a summit sits where the video shows
     * it. Plain drag shifts (offset); shift-drag stretches about the left edge
     * (rate). Both update live, so alignment is judged against the picture
     * rather than trusted from metadata. */
    let drag = null;
    bar.addEventListener("mousedown", (ev) => {
      if (!alignMode || !cal || !video?.duration) return;
      ev.preventDefault();
      drag = {
        x: ev.clientX,
        width: bar.getBoundingClientRect().width,
        offsetSec: cal.offsetSec,
        rate: cal.rate,
        stretch: ev.shiftKey,
      };
    });
    window.addEventListener("mousemove", (ev) => {
      if (!drag) return;
      const dxFrac = (ev.clientX - drag.x) / drag.width;
      const dSec = dxFrac * video.duration;
      if (drag.stretch) {
        // Pivot on the left edge so the early part stays put while the tail
        // stretches -- that is how ad-break drift actually accumulates.
        const spanSec = video.duration;
        cal.rate = Math.max(0.5, Math.min(2.5, drag.rate * (1 + dSec / spanSec)));
      } else {
        cal.offsetSec = drag.offsetSec + dSec;
      }
      updateAlignReadout();
      render();
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      persist();
      updateAlignReadout();
    });

    root.querySelector(".tn-align").addEventListener("click", () => {
      alignMode = !alignMode;
      root.classList.toggle("tn-aligning", alignMode);
      root.querySelector(".tn-align").textContent = alignMode ? "Done" : "Align";
      updateAlignReadout();
    });
    root.querySelector(".tn-anchor-add").addEventListener("click", addAnchor);
    root.querySelector(".tn-auto").addEventListener("click", runAutoCalibrate);
    root.querySelector(".tn-probe").addEventListener("click", runProbe);
    root.querySelector(".tn-anchor-clear").addEventListener("click", () => {
      anchors = [];
      cal = null;
      window.TourNavigatorAutoCal?.resetHistory?.();
      persist();
      refreshAnchorState();
      render();
    });
  }

  /** Let the viewer state which stage this is when detection can't. */
  function populateStagePicker() {
    const sel = root.querySelector(".tn-stage-pick");
    if (!sel || !bundle_index) return;
    sel.innerHTML = "";
    for (const s of bundle_index.stages) {
      const o = document.createElement("option");
      o.value = String(s.stage);
      o.textContent = `Stage ${s.stage} (${s.date})`;
      if (bundle.stage && s.stage === bundle.stage.stage) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      const n = Number(sel.value);
      try { chrome.storage.local.set({ tnPinnedStage: n }, () => location.reload()); }
      catch (_) { location.reload(); }
    });
  }

  function populatePicker() {
    const sel = root.querySelector(".tn-anchor-pick");
    // Anchor quality is not uniform. Summits/sprint/finish come from GPS -- the
    // second the leader physically crossed that point -- while ticker items
    // carry ASO's publication time, which lags what's on screen. Group them so
    // the precise ones are chosen by default.
    const all = bundle.guideposts.filter(
      (g) => g.category === "route" || g.category === "scenic" ||
             g.category === "crash" || g.category === "breakaway_end");
    const isPrecise = (g) => (g.source || "").startsWith("route:");
    const groups = [
      ["Precise (GPS) — best anchors", all.filter(isPrecise)],
      ["Approximate (ticker, lags on-screen)", all.filter((g) => !isPrecise(g))],
    ];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const grp = document.createElement("optgroup");
      grp.label = label;
      for (const g of items) {
        const o = document.createElement("option");
        o.value = g.t_utc;
        o.textContent = `${g.t_utc.slice(11, 16)}Z — ${g.label}`.slice(0, 70);
        grp.appendChild(o);
      }
      sel.appendChild(grp);
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
    cal = calFromAnchors();
    persist();
    refreshAnchorState();
    render();
  }

  /** Derive anchors from caption "km to go" mentions (see autocalibrate.js).
   *  Manual anchors always win: if the fit looks wrong the viewer can just
   *  place their own, and we never silently overwrite them. */
  function runAutoCalibrate() {
    const el = root.querySelector(".tn-anchor-state");
    const api = window.TourNavigatorAutoCal;
    if (!api) { el.textContent = "auto-calibration unavailable"; return; }
    el.textContent = "scanning captions…";
    // Defer so the label paints before the (synchronous) scan runs.
    setTimeout(() => {
      let res;
      try { res = api.autoCalibrate(video, bundle); }
      catch (e) { res = { ok: false, reason: String(e && e.message || e) }; }
      if (!res.ok) {
        el.textContent = `auto-calibrate failed — ${res.reason}`;
        return;
      }
      anchors = res.anchors;
      cal = calFromAnchors();
      persist();
      render();
      if (res.strategy === "broadcast-start") {
        el.textContent = `auto (broadcast start) · ${res.confidence} · ${res.note}` +
          " — add one manual anchor near the finish to correct drift";
      } else {
        el.textContent =
          `auto (captions) · ${res.rate.toFixed(3)}× · ${res.confidence} confidence ` +
          `(${res.inliers}/${res.total} mentions over ${res.spanMin}min, ` +
          `±${Math.round(res.medianResidual)}s)`;
        if (res.confidence !== "high") {
          el.textContent += " — scrub elsewhere and run again to widen the span";
        }
      }
    }, 0);
  }

  /** Dump what this player exposes, and copy it for pasting back. Captions are
   *  not the only possible clock source; this finds out which others exist
   *  here rather than guessing at them. */
  function runProbe() {
    const el = root.querySelector(".tn-anchor-state");
    const api = window.TourNavigatorProbe;
    if (!api) { el.textContent = "probe unavailable"; return; }
    el.textContent = "probing…";
    const finish = (report) => {
      const text = JSON.stringify(report, null, 2);
      console.log("[TourNavigator] capability probe:\n" + text);
      const n = report.startTimeCandidates.length;
      const cues = (report.video?.[0]?.timedSamples || [])
        .reduce((a, t) => a + (t.cueCount || 0), 0);
      navigator.clipboard?.writeText(text).then(
        () => { el.textContent = `probe copied · ${n} start-time candidate(s), ${cues} timed cues · also in console`; },
        () => { el.textContent = `probe in console (clipboard blocked) · ${n} candidate(s), ${cues} cues`; });
    };
    (api.runProbeFull ? api.runProbeFull() : Promise.resolve(api.runProbe()))
      .then(finish)
      .catch((e) => { el.textContent = "probe failed: " + (e && e.message); });
  }

  function updateAlignReadout() {
    const el = root.querySelector(".tn-anchor-state");
    if (!alignMode) { refreshAnchorState(); return; }
    if (!cal) { el.textContent = "align: calibrate first"; return; }
    el.textContent =
      `align · drag = shift, shift-drag = stretch · rate ${cal.rate.toFixed(3)}×` +
      ` · nudge ←/→ 1s, ↑/↓ 10s`;
  }

  /* Keyboard nudging, because the last few seconds of alignment are easier to
   * judge by tapping than by dragging. */
  function onAlignKey(ev) {
    if (!alignMode || !cal) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -10, ArrowUp: 10 }[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    ev.stopPropagation();
    cal.offsetSec += step;
    persist();
    updateAlignReadout();
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
      chrome.storage?.local?.set({ [STORAGE_KEY + ":" + stageKey()]: { anchors, cal } });
    } catch (_) { /* storage is a convenience, not a requirement */ }
  }

  function restore(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY + ":" + stageKey()], (r) => {
        const saved = r?.[STORAGE_KEY + ":" + stageKey()];
        if (saved && saved.cal) { anchors = saved.anchors || []; cal = saved.cal; }
        else { anchors = saved || []; cal = calFromAnchors(); }
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

  /** Ask the page which asset is playing, so the right stage is chosen for us.
   *  The Peacock URL is an opaque asset id, but __PLAYBACK_STATE__ carries the
   *  airing date -- which is exactly what identifies a stage. Getting this
   *  wrong is silent and total: stage 15 data over a stage 14 recording lines
   *  up with nothing, so match on the date rather than assume. */
  function assetAiringMs(report) {
    const ps = (report && report.mainWorld && report.mainWorld.playbackState) || {};
    for (const k of ["displayStartTime", "assetMetadataDisplayStartTime",
                     "eventDisplayStartDate", "eventPlayableStartDate"]) {
      if (typeof ps[k] === "number" && ps[k] > 1e12) return ps[k];
    }
    return null;
  }

  async function loadBundle() {
    const index = await fetch(chrome.runtime.getURL("data/index.json"))
      .then((r) => r.json()).catch(() => null);
    if (!index || !index.stages || !index.stages.length) {
      throw new Error("no stage bundles shipped");
    }

    // A manual choice always wins and is remembered per browser.
    const pinned = await new Promise((res) => {
      try { chrome.storage.local.get(["tnPinnedStage"], (r) => res(r?.tnPinnedStage ?? null)); }
      catch (_) { res(null); }
    });

    let chosen = null, why = "", airing = null;
    if (pinned) {
      chosen = index.stages.find((s) => s.stage === pinned) || null;
      if (chosen) why = `pinned to stage ${pinned}`;
    }

    if (!chosen) {
      // The page can still be booting at document_idle, so retry rather than
      // let a single missed handshake silently pick the wrong stage.
      for (let attempt = 1; attempt <= 3 && !airing; attempt++) {
        try {
          const report = await window.TourNavigatorProbe.runProbeFull();
          airing = assetAiringMs(report);
        } catch (_) { /* keep trying */ }
        if (!airing) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
      if (airing) {
        const day = new Date(airing).toISOString().slice(0, 10);
        chosen = index.stages.find((s) => s.date === day) || null;
        why = chosen ? `matched airing date ${day}`
                     : `airing date ${day} has no bundle — pick a stage`;
      } else {
        why = "could not read airing date — pick a stage";
      }
    }

    // No silent fallback: guessing produces markers that are confidently wrong
    // everywhere, with nothing on screen to reveal it.
    if (!chosen) {
      chosen = index.stages[index.stages.length - 1];
      why += ` (showing stage ${chosen.stage})`;
    }
    console.log("[TourNavigator] stage selection:", why,
                "| airing:", airing ? new Date(airing).toISOString() : null,
                "| available:", index.stages.map((s) => `${s.stage}@${s.date}`));
    bundle_index = index;
    bundle_selection_ok = /matched|pinned/.test(why);
    const bundleRes = await fetch(chrome.runtime.getURL("data/" + chosen.file));
    const b = await bundleRes.json();
    b.__selection = why;
    return b;
  }

  async function start() {
    // Only the top document gets a panel. With all_frames enabled a panel was
    // being built in every iframe, and a subframe cannot see __PLAYBACK_STATE__
    // -- so it fell back to the last bundle and showed the wrong stage while
    // looking perfectly normal.
    if (window.top !== window.self) return;
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
    root.querySelector(".tn-stage").title = bundle.__selection || "";
    populateStagePicker();
    if (!bundle_selection_ok) {
      root.classList.add("tn-warn");
      root.querySelector(".tn-stage").textContent += "  ⚠ " + (bundle.__selection || "");
    }
    restore(() => {
      refreshAnchorState();
      render();
      // Nothing stored for this stage yet: try to calibrate unprompted, since
      // the airing time alone is usually enough to place markers.
      if (!anchors.length) setTimeout(runAutoCalibrate, 800);
    });

    setInterval(() => {
      const v = findVideo();
      if (v && v !== video) { video = v; render(); }
      else if (video) render();
    }, 500);
    window.addEventListener("resize", render);
    window.addEventListener("keydown", onAlignKey, true);
  }

  start();
})();
