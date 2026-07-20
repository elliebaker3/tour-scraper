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
  let hoverEl = null;         // readout element, re-attached after each render
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

  const routeLength = () =>
    bundle.coverage?.route_length_km ||
    Math.max(...bundle.profile.map((p) => p.km)) || 1;

  /** Which axis the bar is drawn against.
   *
   *  Time is what makes the bar *navigable* — but it needs both a calibration
   *  and a loaded video, and until then every point maps to null and the bar
   *  renders empty. The profile itself needs neither: km and altitude are
   *  intrinsic to the scraped route. So distance is the fallback axis, and the
   *  profile is on screen from the moment the panel exists. */
  const axisMode = () => (cal && video?.duration) ? "time" : "dist";

  function profilePath(width, height) {
    const mode = axisMode();
    // Distance mode draws every point; time mode can only draw timed ones.
    const pts = mode === "time" ? bundle.profile.filter((p) => p.t) : bundle.profile;
    if (!pts.length) return { d: "", dEst: "", pts: [] };
    const alts = pts.map((p) => p.alt);
    const loA = Math.min(...alts), hiA = Math.max(...alts);
    const rangeA = Math.max(1, hiA - loA);
    const len = routeLength();

    // Estimated points (GPS came online late, so the head is spanned from the
    // known start time) are drawn as a separate, dimmer shape. The whole stage
    // is shown, but "we saw this" and "we inferred this" stay distinguishable.
    const xy = [], xyEst = [];
    for (const p of pts) {
      let x;
      if (mode === "time") {
        const sec = utcToVideo(Date.parse(p.t));
        if (sec == null || sec < 0 || sec > video.duration) continue;
        x = (sec / video.duration) * width;
      } else {
        x = (p.km / len) * width;      // spans 0 -> finish by construction
      }
      const pt = [x, height - ((p.alt - loA) / rangeA) * (height - 4) - 2];
      (p.est ? xyEst : xy).push(pt);
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

  /** Where a guidepost sits along the route, in km.
   *
   *  Route guideposts (summits, sprints, the finish) carry their own km. Ticker
   *  ones only carry a timestamp, so their position comes from the same
   *  time-synced profile the bar is drawn from. Memoised because render runs
   *  twice a second. */
  const kmCache = new Map();
  function guidepostKm(g) {
    if (typeof g.km === "number") return g.km;
    if (kmCache.has(g.t_utc)) return kmCache.get(g.t_utc);
    const ms = Date.parse(g.t_utc);
    let km = null, prev = null;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      const t = Date.parse(p.t);
      if (t >= ms) {
        if (!prev) { km = p.km; break; }          // before the race rolled out
        const t0 = Date.parse(prev.t), span = t - t0;
        km = prev.km + (p.km - prev.km) * (span > 0 ? (ms - t0) / span : 0);
        break;
      }
      prev = p;
    }
    kmCache.set(g.t_utc, km);
    return km;
  }

  function render() {
    if (!root || !bundle) return;
    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const height = bar.clientHeight || 54;
    const mode = axisMode();
    const len = routeLength();
    const dur = video?.duration || 0;

    const { d, dEst, loA, hiA } = profilePath(width, height);

    // A guidepost's x depends on the axis: recording seconds when calibrated,
    // route km otherwise. Distance mode still places every marker correctly --
    // it just cannot seek to them, since no video time is known yet.
    const markers = [];
    for (const g of bundle.guideposts) {
      if (!enabled[g.category]) continue;
      let x, sec = null, tip;
      if (mode === "time") {
        sec = utcToVideo(Date.parse(g.t_utc));
        if (sec == null || sec < 0 || sec > dur) continue;
        x = (sec / dur) * width;
        tip = `${fmt(sec)} — ${g.label}`;
      } else {
        const km = guidepostKm(g);
        if (km == null) continue;
        x = (km / len) * width;
        tip = `km ${km.toFixed(1)} — ${g.label}`;
      }
      const c = CATEGORIES[g.category]?.color || "#fff";
      markers.push(
        `<div class="tn-marker" style="left:${x.toFixed(1)}px;background:${c}"
              ${sec == null ? "" : `data-sec="${sec.toFixed(1)}"`}
              title="${escapeHtml(tip)}"></div>`);
    }

    // Intensity heat strip: darker = more happening. Only meaningful on the
    // time axis, where its windows correspond to stretches of the recording.
    let heat = "";
    if (mode === "time" && bundle.intensity?.length) {
      for (const s of bundle.intensity) {
        const sec = utcToVideo(Date.parse(s.t_utc));
        if (sec == null || sec < 0 || sec > dur) continue;
        const x = (sec / dur) * width;
        const w = Math.max(1, (s.window_min * 60 / dur) * width);
        heat += `<div class="tn-heat" style="left:${x.toFixed(1)}px;width:${w.toFixed(1)}px;
                  opacity:${(s.normalised * 0.75).toFixed(2)}"></div>`;
      }
    }

    // Distance ticks make the profile readable on its own terms, without
    // needing the playhead or a calibration to give it scale.
    let ticks = "";
    if (mode === "dist") {
      for (const frac of [0.25, 0.5, 0.75]) {
        ticks += `<div class="tn-tick" style="left:${(frac * width).toFixed(1)}px">
                    <span>${Math.round(frac * len)}km</span></div>`;
      }
    }

    // The playhead is only drawn when it means something. In distance mode
    // without a calibration there is no way to know where on the road the
    // video is, and a playhead parked at km 0 reads as "the race is at the
    // start" rather than "unknown".
    const playhead = (dur && (mode === "time" || cal))
      ? `<div class="tn-playhead" style="left:${
           ((mode === "time" ? video.currentTime / dur : playheadKm() / len) * width).toFixed(1)
         }px"></div>`
      : "";

    bar.innerHTML = `
      <div class="tn-heatwrap">${heat}</div>
      <svg class="tn-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="none">
        <path d="${dEst || ""}" class="tn-profile tn-profile-est"/>
        <path d="${d}" class="tn-profile"/>
      </svg>
      <div class="tn-ticks">${ticks}</div>
      <div class="tn-markers">${markers.join("")}</div>
      ${playhead}
      ${d || dEst ? `<span class="tn-alt tn-alt-hi">${Math.round(hiA)}m</span>
             <span class="tn-alt tn-alt-lo">${Math.round(loA)}m</span>` : ""}
      ${mode === "dist"
          ? `<span class="tn-axis tn-axis-warn">✕ NOT aligned to the video — x is
               distance (0–${len.toFixed(0)}km), not time</span>`
          : `<span class="tn-axis">time · aligned to recording</span>`}
    `;

    bar.querySelectorAll(".tn-marker[data-sec]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        video.currentTime = parseFloat(el.dataset.sec);
      });
    });
    bar.appendChild(hoverEl);          // survives the innerHTML rewrite

    const utcNow = dur ? videoToUtc(video.currentTime) : null;
    const clock = root.querySelector(".tn-clock");
    if (utcNow) {
      // State the claim the alignment is making, in the terms you can check it
      // against: if the screen shows a climb and this says descending, the
      // calibration is wrong -- and by roughly how much becomes findable.
      const km = playheadKm();
      const g = gradientAt(km);
      const slope = g == null ? ""
        : ` · km ${km.toFixed(1)} · ${
            g > 1.5 ? `climbing ${g.toFixed(1)}%`
          : g < -1.5 ? `descending ${Math.abs(g).toFixed(1)}%`
          : "flat"}`;
      clock.textContent =
        `race ${new Date(utcNow).toISOString().slice(11, 19)}Z · rec ${fmt(video.currentTime)}${slope}`;
      clock.className = "tn-clock" + (g == null ? "" : g > 1.5 ? " tn-up" : g < -1.5 ? " tn-down" : "");
    } else {
      clock.className = "tn-clock";
      clock.textContent = dur ? `rec ${fmt(video.currentTime)} · not calibrated`
                              : "profile only · no video detected";
    }

    // State the assumptions, always. Every alignment failure so far has been
    // one of these four being quietly wrong, and none of them were visible:
    // which stage is loaded, what date the recording is, where recording
    // second 0 sits in race time, and the rate.
    const diag = root.querySelector(".tn-diag");
    const zero = cal ? videoToUtc(0) : null;
    diag.textContent =
      `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"}) · ` +
      (zero != null
        ? `rec 0:00 = ${new Date(zero).toISOString().slice(11, 19)}Z · ` +
          `rate ${cal.rate.toFixed(3)}×`
        : "no clock") +
      ` · ${bundle.__selection || ""}`;
  }

  /** Gradient at a point on the route, in percent, averaged over ~1km so it
   *  reflects the climb rather than one noisy pair of samples. */
  function gradientAt(km) {
    const near = bundle.profile.filter((p) => Math.abs(p.km - km) <= 0.5);
    if (near.length < 2) return null;
    const a = near[0], b = near[near.length - 1];
    const d = b.km - a.km;
    return d > 0 ? (b.alt - a.alt) / (d * 10) : null;
  }

  /** Nearest profile point to a fractional position along the bar, resolved on
   *  whichever axis is in use. Returns km, altitude, race time and — when the
   *  clock is known — the matching second of the recording. */
  function sampleAt(frac) {
    if (!bundle?.profile?.length) return null;
    const mode = axisMode();
    let best = null;
    if (mode === "dist") {
      const km = frac * routeLength();
      for (const p of bundle.profile) {
        if (!best || Math.abs(p.km - km) < Math.abs(best.km - km)) best = p;
      }
    } else {
      const target = frac * video.duration;
      let bestGap = Infinity;
      for (const p of bundle.profile) {
        if (!p.t) continue;
        const sec = utcToVideo(Date.parse(p.t));
        if (sec == null) continue;
        const gap = Math.abs(sec - target);
        if (gap < bestGap) { best = p; bestGap = gap; }
      }
    }
    if (!best) return null;
    return {
      km: best.km, alt: best.alt, t: best.t, est: best.est,
      sec: best.t ? utcToVideo(Date.parse(best.t)) : null,
    };
  }

  /** km along the route -> second of the recording, via the point's race time. */
  function kmToVideoSec(km) {
    if (!cal) return null;
    let best = null;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      if (!best || Math.abs(p.km - km) < Math.abs(best.km - km)) best = p;
    }
    return best ? utcToVideo(Date.parse(best.t)) : null;
  }

  /** The playhead in distance mode: where the leader was at the current race
   *  time. Without a calibration there is no race time, so it parks at km 0. */
  function playheadKm() {
    const ms = videoToUtc(video.currentTime);
    if (ms == null) return 0;
    let prev = null;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      if (Date.parse(p.t) >= ms) return prev ? prev.km : p.km;
      prev = p;
    }
    return prev ? prev.km : 0;
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
      <div class="tn-diag"></div>
      <div class="tn-controls">
        <div class="tn-filters"></div>
        <div class="tn-anchors">
          <select class="tn-anchor-pick"><option value="">pick a moment…</option></select>
          <button class="tn-anchor-add">Anchor here</button>
          <button class="tn-sync-finish" title="Click at the exact moment the
winner crosses the line. Two unmistakable moments (this and the flag drop)
pin offset and rate exactly.">Finish is NOW</button>
          <button class="tn-sync-start" title="Click at the exact moment the
stage rolls out from km 0.">Km 0 is NOW</button>
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

    hoverEl = document.createElement("div");
    hoverEl.className = "tn-hover";

    bar.addEventListener("click", (ev) => {
      if (alignMode) return;                 // in align mode a click is a drag
      if (!video?.duration) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const frac = (ev.clientX - rect.left) / rect.width;
      if (axisMode() === "time") {
        video.currentTime = frac * video.duration;
        return;
      }
      // Distance axis: a click means "take me to this point on the road". That
      // is only answerable once calibrated, since km -> race time -> recording
      // time needs the middle step. Uncalibrated, seeking is declined rather
      // than approximated -- a plausible-looking wrong seek is worse than none.
      const sec = kmToVideoSec(frac * routeLength());
      if (sec != null) video.currentTime = Math.max(0, Math.min(video.duration, sec));
    });

    /* Hover readout. The profile is on screen permanently, so the numbers
     * behind it should be one mouse-move away rather than requiring a seek. */
    bar.addEventListener("mousemove", (ev) => {
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const s = sampleAt(frac);
      if (!s) { hoverEl.style.display = "none"; return; }
      const bits = [`km ${s.km.toFixed(1)}`, `${Math.round(s.alt)}m`];
      if (s.t) bits.push(`${s.t.slice(11, 16)}Z`);
      if (s.sec != null) bits.push(`rec ${fmt(s.sec)}`);
      if (s.est) bits.push("est");
      hoverEl.textContent = bits.join(" · ");
      hoverEl.style.display = "block";
      // Flip the label inboard near the right edge so it never gets clipped.
      const x = frac * rect.width;
      hoverEl.style.left = `${x.toFixed(0)}px`;
      hoverEl.style.transform = x > rect.width - 130 ? "translateX(-100%)" : "translateX(4px)";
    });
    bar.addEventListener("mouseleave", () => { hoverEl.style.display = "none"; });

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
    root.querySelector(".tn-sync-finish")
        .addEventListener("click", () => syncAt("finish"));
    root.querySelector(".tn-sync-start")
        .addEventListener("click", () => syncAt("start"));
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

  /** Pin the clock against a moment nobody can misidentify.
   *
   *  Everything automatic here infers where recording second 0 sits from the
   *  player's own metadata, and that inference has been wrong. Two moments in
   *  a bike race are unmistakable on screen -- the flag drop and the winner
   *  crossing the line -- and we know both to the second from GPS. Clicking at
   *  one fixes the offset; clicking at both fixes the rate too, which nothing
   *  automatic can supply because ad breaks are unreadable.
   *
   *  This beats the dropdown for the same reason it beats the metadata: no
   *  judgement about WHICH moment you are looking at is involved. */
  function syncAt(kind) {
    const el = root.querySelector(".tn-anchor-state");
    if (!video?.duration) { el.textContent = "no video"; return; }
    const cov = bundle.coverage || {};
    const tUtc = kind === "finish"
      ? cov.leader_last_seen_utc
      : (cov.race_start_utc || cov.leader_first_seen_utc);
    if (!tUtc) { el.textContent = `no ${kind} time in this bundle`; return; }

    const at = video.currentTime;
    // Drop every automatic anchor, not just a previous pin of this kind.
    // Auto anchors carry no `kind`, so filtering on kind alone left them in --
    // and since calFromAnchors reads only the FIRST and LAST anchor by race
    // time, the auto pair (which brackets the whole race) stayed in charge and
    // the manual pin sat harmlessly in the middle, changing nothing. An
    // observation of the broadcast always beats an inference about it.
    anchors = anchors.filter((a) => a.kind && a.kind !== kind);
    anchors.push({ tUtcMs: Date.parse(tUtc), videoSec: at, kind,
                   label: kind === "finish" ? "finish line" : "km 0" });
    anchors.sort((a, b) => a.tUtcMs - b.tUtcMs);
    cal = calFromAnchors();
    persist();
    render();

    // Report what the click implies about the recording, because that is the
    // number that explains why the automatic guess was off.
    const zero = videoToUtc(0);
    const parts = [`${kind} pinned at rec ${fmt(at)}`];
    if (zero != null) {
      parts.push(`=> rec 0:00 = ${new Date(zero).toISOString().slice(11, 19)}Z`);
    }
    parts.push(anchors.length >= 2
      ? `rate ${cal.rate.toFixed(4)}× (both moments pinned)`
      : "rate assumed 1.000× — pin the other moment to fix it");
    el.textContent = parts.join(" · ");
    console.log("[TourNavigator] manual sync:", el.textContent);
  }

  /** Derive anchors from caption "km to go" mentions (see autocalibrate.js).
   *  Manual anchors always win: if the fit looks wrong the viewer can just
   *  place their own, and we never silently overwrite them. */
  function runAutoCalibrate() {
    const el = root.querySelector(".tn-anchor-state");
    const api = window.TourNavigatorAutoCal;
    if (!api) { el.textContent = "auto-calibration unavailable"; return; }
    if (!video) { el.textContent = "auto-calibrate: no video found yet"; return; }
    el.textContent = "calibrating…";
    // autoCalibrate is async: it may have to run the MAIN-world probe before it
    // can see the broadcast's start time.
    (async () => {
      let res;
      try { res = await api.autoCalibrate(video, bundle); }
      catch (e) { res = { ok: false, reason: String(e && e.message || e) }; }
      if (!res.ok) {
        el.textContent = `auto-calibrate failed — ${res.reason}`;
        render();          // repaint so the uncalibrated warning is visible
        return;
      }
      // Never overwrite a manual pin. Those come from watching the broadcast;
      // this comes from guessing at metadata, and the guess has been wrong.
      if (anchors.some((a) => a.kind)) {
        el.textContent = "keeping your manual sync (auto-calibrate would be " +
                         "less accurate) — press reset to discard it";
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
    })();
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

    // The full probe runs unconditionally, even when the stage is pinned.
    // It is the ONLY thing that executes the MAIN-world script, and the
    // broadcast's start time lives in __PLAYBACK_STATE__, which a content
    // script cannot see. Skipping it for pinned stages meant auto-calibration
    // fell back to the content-script-only probe, found no start time, and
    // silently gave up -- so pinning a stage quietly disabled calibration.
    {
      // The page can still be booting at document_idle, so retry rather than
      // let a single missed handshake silently pick the wrong stage.
      for (let attempt = 1; attempt <= 3 && !airing; attempt++) {
        try {
          const report = await window.TourNavigatorProbe.runProbeFull();
          airing = assetAiringMs(report);
        } catch (_) { /* keep trying */ }
        if (!airing) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
      // Detection beats a pin whenever detection actually works. A pin was
      // meant for "the page won't tell us which stage this is", but it was
      // stored globally and consulted first, so pinning a stage once applied
      // it to every later recording -- and because a pinned choice counted as
      // trustworthy, the mismatch never warned. Stage 15 data over a stage 14
      // broadcast aligns with nothing, which is exactly the "zero alignment"
      // this is meant to make impossible.
      const day = airing ? new Date(airing).toISOString().slice(0, 10) : null;
      const detected = day ? index.stages.find((s) => s.date === day) : null;
      if (detected) {
        chosen = detected;
        why = `matched airing date ${day}`;
        if (pinned && pinned !== detected.stage) {
          why += ` (ignoring stale pin to stage ${pinned})`;
          try { chrome.storage.local.remove("tnPinnedStage"); } catch (_) {}
        }
      } else if (pinned && index.stages.find((s) => s.stage === pinned)) {
        chosen = index.stages.find((s) => s.stage === pinned);
        why = `pinned to stage ${pinned}` +
              (day ? ` — but this recording aired ${day}, which has no bundle`
                   : " (no airing time found — calibration may fail)");
      } else if (day) {
        why = `airing date ${day} has no bundle — pick a stage`;
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
    bundle_selection_ok = /^matched/.test(why);   // a pin means detection failed
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
      if (v && v !== video) video = v;
      render();          // unconditional: the profile draws with or without video
    }, 500);
    window.addEventListener("resize", render);
    window.addEventListener("keydown", onAlignKey, true);
  }

  start();
})();
