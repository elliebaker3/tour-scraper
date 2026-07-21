/* Tour Navigator — content script.
 *
 * Draws a guidepost bar over the player: the stage elevation profile plotted
 * against RECORDING time (not distance), with markers for the things worth
 * navigating to. Clicking anywhere on it seeks.
 *
 * The one genuinely hard problem is the clock. Our data is in UTC race time;
 * the player knows only "seconds into this recording". The broadcast has no
 * inserted breaks, so they differ by an offset alone -- one unknown, and one
 * reading fixes it: pause anywhere, type the "km to go" the broadcast is
 * showing, and the profile knows when the leader was there.
 *
 * Nothing is drawn until that reading exists. A profile with no clock invites
 * reading positions off it that are not real, which is how every "the
 * elevation doesn't line up" report so far began.
 *
 * This only reads video.currentTime and sets it to seek. It does not touch,
 * capture or download any stream content.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "tourNavigatorAnchors";
  // Sprints and climbs are part of the elevation graphic, so they default on.
  // The race-event markers all default OFF -- an empty bar is the calm default,
  // and the viewer opts into whichever kind they want to see. History and stats
  // were dropped entirely.
  const CATEGORIES = {
    sprint:          { label: "Sprints",    color: "#22c55e", on: true },
    kom:             { label: "Climbs",     color: "#ef4444", on: true },
    poi:             { label: "★ Contenders", color: "#facc15", on: true },
    crash:           { label: "Crashes",    color: "#e5484d", on: false },
    breakaway_start: { label: "Attacks",    color: "#f5a524", on: false },
    breakaway_end:   { label: "Caught",     color: "#8b7cf6", on: false },
    scenic:          { label: "Scenery",    color: "#30a46c", on: false },
  };

  // Climb grades shade from yellow (cat 4) to deep red (HC), the way a stage
  // profile prints them. Sprints are green, the sprinters' jersey colour.
  const KOM_COLOR = { HC: "#b91c1c", "Cat 1": "#ef4444", "Cat 2": "#f97316",
                      "Cat 3": "#eab308", "Cat 4": "#a3e635" };

  // Persons of interest (contenders for each jersey) are marked when involved
  // in an event, but the rider's identity is NEVER shown -- that would spoil
  // what's about to happen. The names live in the data only to place the
  // markers; nothing about who or what is rendered anywhere in the UI.

  // Vertical padding inside the bar, in px: headroom above the highest point so
  // the peak doesn't jam against the top edge (and leaves room for the markers
  // that sit up there), and a sliver below the lowest.
  const PROFILE_TOP_PAD = 12;
  const PROFILE_BOT_PAD = 2;

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

  /* The broadcast contains no inserted breaks, so rate is 1.0 by construction
   * and ONE known moment is a complete calibration. Fitting a rate from two
   * pins was actively harmful: it turned a few seconds of click imprecision
   * into a slope applied across four hours, and on stage 14 produced 0.918x --
   * "20 minutes of racing missing" -- from what is really a single mis-click.
   *
   * km 0 is the one input, and it is enough. */
  function pins() { return anchors.filter((a) => a.kind); }

  function _median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Ad breaks read straight from the player. Peacock's cvsdk-event-track carries
   * a cue per ad break, id'd `cvsdk::ad-break-N`; its [start,end] is the break's
   * position and length in the recording. This is exact, so the break locations
   * never have to be guessed from readings. */
  function adBreaksFromPlayer() {
    const v = video;
    if (!v || !v.textTracks) return [];
    const out = [];
    for (const tr of v.textTracks) {
      if (!/metadata/i.test(tr.kind || "")) continue;
      try { if (tr.mode === "disabled") tr.mode = "hidden"; } catch (_) {}
      for (const c of tr.cues || []) {
        if (c.id && /ad-break/i.test(c.id) && isFinite(c.startTime) && isFinite(c.endTime)) {
          out.push({ t: c.startTime, e: c.endTime, d: c.endTime - c.startTime });
        }
      }
    }
    out.sort((a, b) => a.t - b.t);
    // Drop any that overlap a kept one (defensive; ad-break cues don't nest).
    const kept = [];
    for (const b of out) if (!kept.length || b.t >= kept[kept.length - 1].e) kept.push(b);
    return kept;
  }

  /** Ad-break seconds fully before a recording second. */
  function cumAd(sec, breaks) {
    let s = 0;
    for (const b of breaks) { if (b.e <= sec) s += b.d; else break; }
    return s;
  }

  /* Calibration model.
   *
   * With the ad breaks known, race time maps to recording time as:
   *     race = R0 + rec + k * cumAd(rec)
   * -- rate 1 through content, plus the race lost so far to ad breaks. cumAd is
   * exact from the cues; R0 (origin) and k (race lost per ad-second) are the
   * only unknowns, so TWO readings across at least one break fit the whole
   * stage, however many breaks there are. One reading fits R0 with k assumed 1
   * (each break lost about its own length); more readings least-squares both.
   *
   * With no cue track (not Peacock, or markup changed) it falls back to the
   * previous cue-less piecewise model: rate 1, offset stepped at the midpoint
   * between readings that disagree. */
  const CUT_EPS_SEC = 25;

  function calFromAnchors() {
    const p = pins();
    if (!p.length) return null;
    const reads = p.map((a) => ({ rec: a.videoSec, race: a.tUtcMs / 1000 }))
                   .sort((a, b) => a.rec - b.rec);
    const breaks = adBreaksFromPlayer();

    if (breaks.length) {
      const xs = reads.map((r) => cumAd(r.rec, breaks));   // ad-secs before it
      const ys = reads.map((r) => r.race - r.rec);         // = R0 + k*x
      let k, R0;
      if (reads.length >= 2 && Math.max(...xs) - Math.min(...xs) > 30) {
        const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n,
              my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
        k = Math.max(0, Math.min(2, den ? num / den : 1));
        R0 = my - k * mx;
      } else {
        k = 1;                                             // one reading: assume full loss
        R0 = _median(ys.map((y, i) => y - k * xs[i]));
      }
      // Content regions between breaks, each with its cumulative ad-time.
      const regions = [{ recLo: -Infinity, recHi: breaks[0].t, C: 0 }];
      let cum = 0;
      for (let i = 0; i < breaks.length; i++) {
        cum += breaks[i].d;
        regions.push({ recLo: breaks[i].e, C: cum,
                       recHi: i + 1 < breaks.length ? breaks[i + 1].t : Infinity });
      }
      return { model: "adbreak", breaks, R0, k, regions, readings: reads.length };
    }

    // ---- fallback: cue-less piecewise (midpoint seams) ----
    const rd = reads.map((r) => ({ v: r.rec, zero: r.race - r.rec }));
    const groups = [[rd[0]]];
    for (let i = 1; i < rd.length; i++) {
      if (Math.abs(rd[i].zero - rd[i - 1].zero) > CUT_EPS_SEC) groups.push([]);
      groups[groups.length - 1].push(rd[i]);
    }
    const segs = groups.map((g) => ({
      zero: _median(g.map((r) => r.zero)), vFirst: g[0].v, vLast: g[g.length - 1].v,
    }));
    for (let i = 0; i < segs.length; i++) {
      segs[i].vLo = i === 0 ? -Infinity : (segs[i - 1].vLast + segs[i].vFirst) / 2;
      segs[i].vHi = i === segs.length - 1 ? Infinity : (segs[i].vLast + segs[i + 1].vFirst) / 2;
    }
    const cuts = [];
    for (let i = 1; i < segs.length; i++) {
      cuts.push({ atVideoSec: segs[i].vLo, removedSec: segs[i].zero - segs[i - 1].zero });
    }
    return { model: "piecewise", segs, cuts, readings: reads.length };
  }

  /** recording second -> race UTC (ms). */
  function videoToUtc(sec) {
    if (!cal) return null;
    if (cal.model === "adbreak") {
      return (cal.R0 + sec + cal.k * cumAd(sec, cal.breaks)) * 1000;
    }
    let s = cal.segs[cal.segs.length - 1];
    for (const g of cal.segs) if (sec < g.vHi) { s = g; break; }
    return (sec + s.zero) * 1000;
  }

  /** race UTC (ms) -> recording second. Race time lost inside an ad break has
   *  no recording position, so it snaps to where content resumes. */
  function utcToVideo(tUtcMs) {
    if (!cal) return null;
    const R = tUtcMs / 1000;
    if (cal.model === "adbreak") {
      for (const g of cal.regions) {
        const rec = R - cal.R0 - cal.k * g.C;
        if (rec >= g.recLo && rec < g.recHi) return rec;
      }
      for (const g of cal.regions) {                       // in a lost gap
        const lo = g.recLo === -Infinity ? 0 : g.recLo;
        if (cal.R0 + lo + cal.k * g.C > R) return lo;
      }
      const last = cal.regions[cal.regions.length - 1];
      return R - cal.R0 - cal.k * last.C;
    }
    const S = cal.segs;
    for (const s of S) if (R >= s.zero + s.vLo && R < s.zero + s.vHi) return R - s.zero;
    for (let i = 1; i < S.length; i++) if (S[i].zero + S[i].vLo > R) return S[i].vLo;
    return R - S[S.length - 1].zero;
  }

  /** Recording-second error of each reading against the model (rounding scatter). */
  function pinResidualsSec() {
    if (!cal) return [];
    return pins().map((a) => a.videoSec - utcToVideo(a.tUtcMs));
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

  /* Distance is reported as km REMAINING, which is how a bike race is actually
   * called and how the riders' own numbers run. Read the profile's `kmto`
   * column rather than subtracting from a stage length: stages.json says 155.5
   * for stage 14 where the route file says 155.2, and adopting that 0.3 km
   * would reintroduce the constant offset the sync was built to remove. */
  const kmToGo = (p) =>
    typeof p?.kmto === "number" ? p.kmto : routeLength() - (p?.km ?? 0);
  const fmtToGo = (v) => `${v.toFixed(1)} km to go`;


  /** Profile points that carry a race time, ascending. Built once per bundle. */
  let _series = null;
  function series() {
    if (_series) return _series;
    _series = bundle.profile
      .filter((p) => p.t)
      .map((p) => ({ t: Date.parse(p.t), alt: p.alt, km: p.km,
                     kmto: p.kmto, est: !!p.est }))
      .sort((a, b) => a.t - b.t);
    return _series;
  }

  /** Race time at which the leader had `km` left to race.
   *
   *  This is what makes the broadcast's own "N km to go" graphic usable as a
   *  calibration: the graphic gives km, the profile gives the time the leader
   *  was there, and the pair is an anchor. Interpolated, so accuracy is not
   *  limited by the downsampled point spacing.
   *
   *  Returns null outside the covered range, and flags the estimated head --
   *  where pace was inferred rather than observed, so a pin there inherits
   *  that uncertainty. */
  let _byKmTo = null;
  function timeAtKmToGo(km) {
    if (!_byKmTo) _byKmTo = [...series()].sort((a, b) => a.kmto - b.kmto);
    const s = _byKmTo;
    if (!s.length || km < s[0].kmto || km > s[s.length - 1].kmto) return null;
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].kmto <= km) lo = mid; else hi = mid;
    }
    const a = s[lo], b = s[hi];
    const span = b.kmto - a.kmto;
    const f = span > 0 ? (km - a.kmto) / span : 0;
    return { tMs: a.t + (b.t - a.t) * f, est: a.est || b.est };
  }

  /** Elevation at a race time, with how it was arrived at.
   *
   *  The recording is longer than the race: there is build-up before km 0 and
   *  coverage after the line, and those stretches have no elevation because
   *  nobody was riding. Leaving them blank breaks the bar into fragments, so
   *  they are imputed -- held at the start and finish altitudes, which is
   *  where the race actually was -- and drawn faintly so an imputed stretch
   *  never reads as measured. Gaps inside the race are bridged linearly. */
  function elevationAt(tMs) {
    const s = series();
    if (!s.length) return null;
    if (tMs <= s[0].t) return { alt: s[0].alt, cls: "imp" };
    if (tMs >= s[s.length - 1].t) return { alt: s[s.length - 1].alt, cls: "imp" };
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= tMs) lo = mid; else hi = mid;
    }
    const a = s[lo], b = s[hi];
    const span = b.t - a.t;
    const alt = span > 0 ? a.alt + (b.alt - a.alt) * ((tMs - a.t) / span) : a.alt;
    return { alt, cls: (a.est || b.est) ? "est" : "obs" };
  }

  /** The profile as SVG areas, one per kind of claim.
   *
   *  Sampled once per pixel column rather than once per route point, so every
   *  column of the bar gets a value -- measured, estimated, or imputed where
   *  the recording is running but no race is (build-up, post-finish). */
  function profilePath(width, height) {
    const alts = bundle.profile.map((p) => p.alt);
    const loA = Math.min(...alts), hiA = Math.max(...alts);
    const rangeA = Math.max(1, hiA - loA);
    const y = (alt) => height - ((alt - loA) / rangeA) * (height - PROFILE_TOP_PAD - PROFILE_BOT_PAD) - PROFILE_BOT_PAD;
    const area = (arr) => {
      if (arr.length < 2) return "";
      let s = `M ${arr[0][0].toFixed(1)} ${height} L `;
      s += arr.map(([x, yy]) => `${x.toFixed(1)} ${yy.toFixed(1)}`).join(" L ");
      s += ` L ${arr[arr.length - 1][0].toFixed(1)} ${height} Z`;
      return s;
    };

    const cols = [];
    for (let px = 0; px <= width; px++) {
      const sec = (px / width) * video.duration;
      const tMs = videoToUtc(sec);
      const e = tMs == null ? null : elevationAt(tMs);
      if (e) cols.push({ x: px, y: y(e.alt), cls: e.cls });
    }
    // Contiguous runs of one class become one path, each sharing a point with
    // its neighbour so the silhouette has no seams.
    const segs = [];
    let run = [];
    for (let i = 0; i < cols.length; i++) {
      run.push(cols[i]);
      const last = i === cols.length - 1;
      if (last || cols[i + 1].cls !== cols[i].cls) {
        if (!last) run.push(cols[i + 1]);
        segs.push({ cls: cols[i].cls, d: area(run.map((c) => [c.x, c.y])) });
        run = [cols[i]];
      }
    }
    return { segs, loA, hiA };
  }

  /** The profile as SVG areas, one per kind of claim.
   *
   *  Sampled once per pixel column rather than once per route point, so every
   *  column of the bar gets a value -- measured, estimated, or imputed where
   *  the recording is running but no race is (build-up, post-finish). */
  function profilePath(width, height) {
    const alts = bundle.profile.map((p) => p.alt);
    const loA = Math.min(...alts), hiA = Math.max(...alts);
    const rangeA = Math.max(1, hiA - loA);
    const y = (alt) => height - ((alt - loA) / rangeA) * (height - PROFILE_TOP_PAD - PROFILE_BOT_PAD) - PROFILE_BOT_PAD;
    const area = (arr) => {
      if (arr.length < 2) return "";
      let s = `M ${arr[0][0].toFixed(1)} ${height} L `;
      s += arr.map(([x, yy]) => `${x.toFixed(1)} ${yy.toFixed(1)}`).join(" L ");
      s += ` L ${arr[arr.length - 1][0].toFixed(1)} ${height} Z`;
      return s;
    };

    const cols = [];
    for (let px = 0; px <= width; px++) {
      const sec = (px / width) * video.duration;
      const tMs = videoToUtc(sec);
      const e = tMs == null ? null : elevationAt(tMs);
      if (e) cols.push({ x: px, y: y(e.alt), cls: e.cls });
    }
    // Contiguous runs of one class become one path, each sharing a point with
    // its neighbour so the silhouette has no seams.
    const segs = [];
    let run = [];
    for (let i = 0; i < cols.length; i++) {
      run.push(cols[i]);
      const last = i === cols.length - 1;
      if (last || cols[i + 1].cls !== cols[i].cls) {
        if (!last) run.push(cols[i + 1]);
        segs.push({ cls: cols[i].cls, d: area(run.map((c) => [c.x, c.y])) });
        run = [cols[i]];
      }
    }
    return { segs, loA, hiA };
  }


  function render() {
    if (!root || !bundle) return;
    const dur = video?.duration || 0;

    // Until it is calibrated there is nothing honest to draw: the profile only
    // means something once every position on the bar is a known moment of the
    // race. Showing a shape before then invites reading positions off it that
    // are not real, which is exactly how "the elevation doesn't line up" kept
    // happening. So the panel is the setup prompt and nothing else.
    const ready = !!(cal && dur);
    root.classList.toggle("tn-needs-setup", !ready);
    const note = root.querySelector(".tn-setup-note");
    if (!ready) {
      note.textContent = dur ? "" : "waiting for the player…";
      root.querySelector(".tn-clock").textContent = "not calibrated";
      root.querySelector(".tn-diag").textContent =
        `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"}) · ` +
        `${bundle.__selection || ""}`;
      return;
    }

    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const height = bar.clientHeight || 54;

    const { segs, loA, hiA } = profilePath(width, height);
    const CLS = { obs: "tn-profile", est: "tn-profile tn-profile-est",
                  imp: "tn-profile tn-profile-imp" };
    const paths = segs.filter((g) => g.d)
      .map((g) => `<path d="${g.d}" class="${CLS[g.cls]}"/>`).join("");
    const rangeA = Math.max(1, hiA - loA);
    const yForAlt = (alt) => height - ((alt - loA) / rangeA) * (height - PROFILE_TOP_PAD - PROFILE_BOT_PAD) - PROFILE_BOT_PAD;

    // Sprints and climbs sit ON the elevation curve, at their own altitude, the
    // way a printed stage profile marks them. Drawn from route_markers, which
    // comes straight from ASO's route data, so they are exact and never lost to
    // downsampling. Climbs are flagged with their category (HC / 1-4).
    const routeMarks = [];
    for (const m of bundle.route_markers || []) {
      if (!m.t || !enabled[m.kind]) continue;
      const sec = utcToVideo(Date.parse(m.t));
      if (sec == null || sec < 0 || sec > dur) continue;
      const x = (sec / dur) * width;
      const y = m.alt != null ? yForAlt(m.alt) : height / 2;
      const isKom = m.kind === "kom";
      const color = isKom ? (KOM_COLOR[m.cat] || "#ef4444") : CATEGORIES.sprint.color;
      const badge = isKom ? (m.finish ? "🏁" : (m.cat || "").replace("Cat ", "")) : "S";
      const tip = m.label +
                  (m.kmto != null ? ` · ${m.kmto} km to go · ${m.alt}m` : "");
      // Keep the badge fully inside the bar. It normally floats above the dot,
      // but summits sit near the top, so flip it below when there isn't room;
      // and shift it inward at the very edges so it is never clipped.
      const place =
        (y < 20 ? " tn-rm-below" : "") +
        (x < 16 ? " tn-rm-atleft" : x > width - 16 ? " tn-rm-atright" : "");
      routeMarks.push(
        `<div class="tn-rm tn-rm-${m.kind}${m.finish ? " tn-rm-finish" : ""}${place}"
              style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--rm:${color}"
              data-sec="${sec.toFixed(1)}" title="${escapeHtml(tip)}">
           <span class="tn-rm-badge">${escapeHtml(badge)}</span>
         </div>`);
    }

    const markers = [];
    for (const g of bundle.guideposts) {
      if (!enabled[g.category]) continue;
      const sec = utcToVideo(Date.parse(g.t_utc));
      if (sec == null || sec < 0 || sec > dur) continue;
      const x = (sec / dur) * width;
      const c = CATEGORIES[g.category]?.color || "#fff";
      markers.push(
        `<div class="tn-marker" style="left:${x.toFixed(1)}px;background:${c}"
              data-sec="${sec.toFixed(1)}"
              title="${escapeHtml(g.label)}"></div>`);
    }

    // One uniform marker for ANY person-of-interest event -- same for every
    // rider and every event kind. Deliberately NO tooltip: revealing who or
    // what happens would be a spoiler. It only says "a contender moment is
    // here", and clicking seeks to it so you can watch it unfold yourself.
    const poiMarks = [];
    if (enabled.poi) {
      for (const m of bundle.special_markers || []) {
        const sec = utcToVideo(Date.parse(m.t_utc));
        if (sec == null || sec < 0 || sec > dur) continue;
        const x = (sec / dur) * width;
        poiMarks.push(
          `<div class="tn-poi" style="left:${x.toFixed(1)}px"
                data-sec="${sec.toFixed(1)}"><span class="tn-poi-dot"></span></div>`);
      }
    }

    let heat = "";
    for (const s of bundle.intensity || []) {
      const sec = utcToVideo(Date.parse(s.t_utc));
      if (sec == null || sec < 0 || sec > dur) continue;
      const x = (sec / dur) * width;
      const w = Math.max(1, (s.window_min * 60 / dur) * width);
      heat += `<div class="tn-heat" style="left:${x.toFixed(1)}px;width:${w.toFixed(1)}px;
                opacity:${(s.normalised * 0.75).toFixed(2)}"></div>`;
    }

    const playX = (video.currentTime / dur) * width;
    bar.innerHTML = `
      <div class="tn-heatwrap">${heat}</div>
      <svg class="tn-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="none">
        ${paths}
      </svg>
      <div class="tn-markers">${markers.join("")}</div>
      <div class="tn-routemarks">${routeMarks.join("")}</div>
      <div class="tn-poimarks">${poiMarks.join("")}</div>
      <div class="tn-playhead" style="left:${playX.toFixed(1)}px"></div>
      ${paths ? `<span class="tn-alt tn-alt-hi">${Math.round(hiA)}m</span>
             <span class="tn-alt tn-alt-lo">${Math.round(loA)}m</span>` : ""}
    `;
    bar.querySelectorAll(".tn-marker, .tn-rm, .tn-poi").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        video.currentTime = parseFloat(el.dataset.sec);
      });
    });
    bar.appendChild(hoverEl);

    // Playhead readout: km-to-go and gradient only. The wall-clock race time
    // and the recording position were dropped -- they are machinery, not what
    // a viewer navigates by.
    const clock = root.querySelector(".tn-clock");
    const here = playheadPoint();
    const g = here ? gradientAt(here.km) : null;
    const bits = [];
    if (here) bits.push(fmtToGo(kmToGo(here)));
    if (g != null) bits.push(g > 1.5 ? `climbing ${g.toFixed(1)}%`
                           : g < -1.5 ? `descending ${Math.abs(g).toFixed(1)}%`
                           : "flat");
    clock.textContent = bits.join(" · ");
    clock.className = "tn-clock" +
      (g == null ? "" : g > 1.5 ? " tn-up" : g < -1.5 ? " tn-down" : "");

    const model = cal.model === "adbreak"
      ? `${cal.breaks.length} ad breaks (from player)`
      : `${(cal.cuts || []).length} cut${(cal.cuts || []).length === 1 ? "" : "s"}`;
    root.querySelector(".tn-diag").textContent =
      `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"}) · ` +
      `${cal.readings} reading${cal.readings === 1 ? "" : "s"} · ${model}` +
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

  /** Nearest profile point to a fractional position along the bar. */
  function sampleAt(frac) {
    if (!bundle?.profile?.length || !cal || !video?.duration) return null;
    const target = frac * video.duration;
    let best = null, bestGap = Infinity;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      const sec = utcToVideo(Date.parse(p.t));
      if (sec == null) continue;
      const gap = Math.abs(sec - target);
      if (gap < bestGap) { best = p; bestGap = gap; }
    }
    if (!best) return null;
    return {
      km: best.km, kmto: kmToGo(best), alt: best.alt, t: best.t, est: best.est,
      sec: utcToVideo(Date.parse(best.t)),
    };
  }

  /** The route point the playhead is currently sitting on. */
  function playheadPoint() {
    const ms = videoToUtc(video.currentTime);
    if (ms == null) return null;
    let prev = null;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      if (Date.parse(p.t) >= ms) return prev || p;
      prev = p;
    }
    return prev;
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
        <button class="tn-probe" title="Report what timing data the player
exposes — including ad-break cue times. Copies to the clipboard.">Diagnose</button>
        <button class="tn-collapse" title="Hide">–</button>
      </div>
      <div class="tn-setup">
        <span class="tn-setup-ask">Pause where the broadcast shows
          <strong>km to go</strong> and type it here (best: one reading early,
          one near the finish):</span>
        <input class="tn-togo-km" size="5" placeholder="42" inputmode="decimal">
        <span class="tn-setup-unit">km to go</span>
        <button class="tn-togo-set">Calibrate</button>
        <span class="tn-setup-note"></span>
      </div>
      <div class="tn-bar"></div>
      <div class="tn-diag"></div>
      <div class="tn-controls">
        <div class="tn-filters"></div>
        <div class="tn-anchors">
          <input class="tn-togo-km2" size="5" placeholder="42" inputmode="decimal"
                 title="Refine: type another km-to-go reading from elsewhere in
the stage. The median of all readings is used.">
          <button class="tn-togo-set2">Add reading</button>
          <button class="tn-anchor-clear" title="Clear the calibration">reset</button>
          <span class="tn-anchor-state"></span>
        </div>
      </div>`;
    document.body.appendChild(root);

    const filters = root.querySelector(".tn-filters");
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      const el = document.createElement("label");
      el.className = "tn-filter";
      el.innerHTML = `<input type="checkbox" ${enabled[key] ? "checked" : ""}>
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

    // Every position on the bar is a recording time, so a click is just a seek.
    bar.addEventListener("click", (ev) => {
      if (!cal || !video?.duration) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      video.currentTime = ((ev.clientX - rect.left) / rect.width) * video.duration;
    });

    bar.addEventListener("mousemove", (ev) => {
      if (!cal) return;
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const s = sampleAt(frac);
      if (!s) { hoverEl.style.display = "none"; return; }
      const bits = [fmtToGo(s.kmto), `${Math.round(s.alt)}m`];
      if (s.est) bits.push("est");
      hoverEl.textContent = bits.join(" · ");
      hoverEl.style.display = "block";
      const x = frac * rect.width;
      hoverEl.style.left = `${x.toFixed(0)}px`;
      hoverEl.style.transform = x > rect.width - 130 ? "translateX(-100%)" : "translateX(4px)";
    });
    bar.addEventListener("mouseleave", () => { hoverEl.style.display = "none"; });

    // One calibration route, offered in two places: the setup panel before
    // there is anything to show, and a compact field afterwards for refining.
    for (const [inputSel, buttonSel] of [[".tn-togo-km", ".tn-togo-set"],
                                         [".tn-togo-km2", ".tn-togo-set2"]]) {
      const input = root.querySelector(inputSel);
      const apply = () => {
        syncKmToGo(parseFloat(String(input.value).replace(",", ".")));
        input.value = "";
      };
      root.querySelector(buttonSel).addEventListener("click", apply);
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") apply();
      });
    }

    root.querySelector(".tn-anchor-clear").addEventListener("click", () => {
      anchors = [];
      cal = null;
      clearStored();
      refreshAnchorState();
      render();
    });
    root.querySelector(".tn-probe").addEventListener("click", runProbe);
  }

  /** Dump what timing data this player exposes -- video timing, app-state
   *  timestamps, and every metadata-track cue (where ad-break markers hide) --
   *  and copy it to the clipboard so it can be shared back. Read-only. */
  function runProbe() {
    // Feedback goes wherever is visible: the setup note before calibration, the
    // status line after (the controls are hidden until then).
    const el = cal ? root.querySelector(".tn-anchor-state")
                   : root.querySelector(".tn-setup-note");
    const api = window.TourNavigatorProbe;
    if (!api) { el.textContent = "probe unavailable"; return; }
    el.textContent = "probing…";
    const finish = (report) => {
      const text = JSON.stringify(report, null, 2);
      console.log("[TourNavigator] capability probe:\n" + text);
      const cues = (report.video?.[0]?.timedSamples || [])
        .reduce((a, t) => a + (t.cueCount || 0), 0);
      navigator.clipboard?.writeText(text).then(
        () => { el.textContent = `probe copied · ${cues} metadata cues · also in the console`; },
        () => { el.textContent = `probe in the console (clipboard blocked) · ${cues} cues`; });
    };
    (api.runProbeFull ? api.runProbeFull() : Promise.resolve(api.runProbe()))
      .then(finish)
      .catch((e) => { el.textContent = "probe failed: " + (e && e.message); });
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
  /** Calibrate from the km-to-go the broadcast is showing.
   *
   *  The most available anchor there is: the graphic is on screen almost
   *  continuously, so any moment works, where km 0 and the finish each happen
   *  once and have to be hunted for.
   *
   *  Accuracy is bounded by the graphic, not by us. It counts in whole
   *  kilometres, so "42" means somewhere in [42, 43) -- half a kilometre of
   *  ambiguity, which at racing speed is around 45 seconds. That is reported
   *  rather than hidden, and it is why several pins are better than one: the
   *  median cancels rounding that falls either way. */
  function syncKmToGo(km) {
    const el = root.querySelector(".tn-anchor-state");
    if (!video?.duration) { el.textContent = "no video"; return; }
    if (!isFinite(km)) { el.textContent = "enter the kilometres to go, e.g. 42"; return; }

    const len = routeLength();
    if (km < 0 || km > len) {
      el.textContent = `${km} km to go is outside this stage (0–${len.toFixed(1)} km)`;
      return;
    }
    // A whole-kilometre graphic reads "42" from 42.0 down to 43.0, so the
    // midpoint is the best single estimate of what it meant.
    const exact = Number.isInteger(km) ? km + 0.5 : km;
    const hit = timeAtKmToGo(exact);
    if (!hit) {
      el.textContent = `no GPS coverage at ${km} km to go — try another point`;
      return;
    }

    const at = video.currentTime;
    anchors = anchors.filter((a) => a.kind);
    anchors.push({ tUtcMs: hit.tMs, videoSec: at, kind: "kmtogo", km,
                   label: `${km} km to go` });
    cal = calFromAnchors();
    render();

    const p = pins();
    const parts = [`${km} km to go — reading added`];
    if (hit.est) parts.push("⚠ that stretch has no GPS — pace is inferred there");

    if (cal.model === "adbreak") {
      // Ad breaks locate themselves from the player. One reading fixes the
      // origin but has to ASSUME how much race each break costs (its own
      // length); if that's off, the error grows with every later break -- the
      // drift-toward-the-end. A second reading NEAR THE FINISH fixes it: the two
      // readings, far apart, fit the per-break loss instead of assuming it.
      parts.push(`${cal.breaks.length} ad breaks from the player`);
      if (p.length === 1) {
        parts.push("origin set — ▶ add a reading NEAR THE FINISH so it stays " +
                   "accurate to the end");
      } else {
        // The wider the spread in ad-time between readings, the better k is
        // pinned; two close-together readings can't fit it.
        const xs = pins().map((a) => cumAd(a.videoSec, cal.breaks));
        const spanMin = (Math.max(...xs) - Math.min(...xs)) / 60;
        parts.push(`${p.length} readings · ~${Math.round(cal.k * 100)}% of each break lost`);
        if (spanMin < 3) {
          parts.push("⚠ readings too close together — put one near the finish");
        }
        const worst = Math.max(0, ...pinResidualsSec().map(Math.abs));
        if (worst > 90) parts.push("⚠ readings disagree — re-check one");
      }
    } else {
      const cuts = cal.cuts || [];
      if (p.length === 1) {
        parts.push("this span is exact");
        parts.push("▶ add a reading in each other part of the stage");
      } else {
        parts.push(`${p.length} readings`);
        parts.push(cuts.length
          ? `${cuts.length} cut${cuts.length > 1 ? "s" : ""} ` +
            `(${cuts.map((c) => `${Math.round(c.removedSec / 60)}m`).join(", ")})`
          : "no cuts between them");
      }
    }
    el.textContent = parts.join(" · ");
    console.log("[TourNavigator] km-to-go sync:", el.textContent);
  }







  function refreshAnchorState() {
    const el = root.querySelector(".tn-anchor-state");
    const p = pins();
    if (!p.length) { el.textContent = "not calibrated"; return; }
    if (cal.model === "adbreak") {
      el.textContent = `${p.length} reading${p.length === 1 ? "" : "s"} · ` +
        `${cal.breaks.length} ad breaks from the player` +
        (p.length === 1 ? " — add one near the finish for the end of the stage" : "");
      return;
    }
    if (p.length === 1) {
      el.textContent = "1 reading · exact in this span — add one in each other part of the stage";
      return;
    }
    const nCuts = (cal.cuts || []).length;
    el.textContent = `${p.length} readings · ` +
      (nCuts ? `${nCuts} cut${nCuts > 1 ? "s" : ""} modelled` : "no cuts");
  }


  /* Calibration is deliberately NOT persisted. It only ever takes one number,
   * and restoring a saved one across reloads is what made the panel flash the
   * prompt and then snap back to a stale bar. Every load starts uncalibrated
   * and asks for the current km-to-go. clearStored() also wipes anything an
   * older, persisting version left behind, so a stale entry can never resurface. */
  function clearStored() {
    try {
      chrome.storage?.local?.remove(STORAGE_KEY + ":" + stageKey());
    } catch (_) { /* storage is a convenience, not a requirement */ }
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
    const s = bundle.stage || {};
    root.querySelector(".tn-stage").textContent =
      `Stage ${s.stage ?? "?"} · ${s.departure ?? ""} → ${s.arrival ?? ""} · ${s.length_km ?? "?"}km`;
    root.querySelector(".tn-stage").title = bundle.__selection || "";
    populateStagePicker();
    if (!bundle_selection_ok) {
      root.classList.add("tn-warn");
      root.querySelector(".tn-stage").textContent += "  ⚠ " + (bundle.__selection || "");
    }
    // Start uncalibrated, every load. One km-to-go reading is the whole setup,
    // and NOT carrying a saved one over is deliberate: restoring it is what
    // made the prompt flash and then revert to a stale bar.
    clearStored();
    anchors = [];
    cal = null;
    refreshAnchorState();
    render();

    setInterval(() => {
      const v = findVideo();
      if (v && v !== video) video = v;
      render();          // unconditional: the profile draws with or without video
    }, 500);
    window.addEventListener("resize", render);

    installChrome();
  }

  /* Appearance timing and position. The panel is meant to ride with the
   * player's own control bar: sit just above it, and appear/disappear with it.
   *
   * The reliable anchor is the native bar ITSELF. We look for it in the DOM
   * every ~200ms; when it is visible we park the panel just above its top edge
   * (so it never overlaps it) and show the panel, and when it fades we hide.
   * That ties both position AND timing to the real control bar regardless of
   * how tall it is or when the player decides to show it.
   *
   * If the native bar can't be found (Peacock reshuffles its markup), we fall
   * back to mouse-movement timing and a safe fixed offset, so the panel still
   * behaves rather than sticking or covering the controls. */
  function nativeControlBar() {
    // The native scrub/seek bar or its controls cluster: a wide element low in
    // the viewport that is currently visible.
    // Deliberately the SEEK BAR itself, not the controls container: the seek
    // bar fades in and out with the controls, so it doubles as a visibility
    // signal, whereas a persistent container would never let the panel hide.
    // It also sits at the TOP of the control cluster (buttons beneath it), so
    // parking above its top edge clears the whole cluster.
    const SEL = [
      '[role="slider"]', 'input[type="range"]',
      '[aria-label*="seek" i]', '[aria-label*="scrubber" i]',
      '[aria-label*="progress bar" i]',
      '[class*="scrubber" i]', '[class*="seekbar" i]', '[class*="seek-bar" i]',
      '[class*="progress-bar" i]', '[class*="progressBar"]',
      '[data-testid*="scrubber" i]', '[data-testid*="seek" i]',
    ].join(",");
    let top = null;
    let els;
    try { els = document.querySelectorAll(SEL); } catch (_) { return null; }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.4) continue;      // must be a wide bar
      if (r.top < window.innerHeight * 0.55) continue;      // low in the frame
      if (r.width === 0 || r.height === 0) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" ||
          parseFloat(st.opacity) < 0.05) continue;          // faded out = hidden
      if (top == null || r.top < top) top = r.top;          // the cluster's top
    }
    return top;
  }

  function installChrome() {
    const GAP = 12;                 // px to float above the native bar
    const HIDE_AFTER_MS = 1000;
    let hideTimer = null;

    const show = () => root.classList.remove("tn-hidden");
    const hide = () => { if (!root.matches(":hover")) root.classList.add("tn-hidden"); };

    // Visibility is driven by mouse movement, plain and reliable: any movement
    // shows the panel and (re)arms a timer that hides it after a few idle
    // seconds -- the same gesture that shows/hides the player's own controls,
    // so the two track each other. An earlier attempt tied hiding to detecting
    // the native bar in the DOM; when that detection latched onto a persistent
    // element the panel never hid, so hiding no longer depends on it.
    const kick = () => {
      show();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_AFTER_MS);
    };
    document.addEventListener("mousemove", kick, { passive: true });
    document.addEventListener("keydown", kick, true);
    root.addEventListener("mouseenter", () => { clearTimeout(hideTimer); show(); });
    root.addEventListener("mouseleave", kick);

    // Positioning ONLY: park the panel just above the native control bar when it
    // can be found, so it hovers over the scrubber rather than covering it.
    // This never affects whether the panel is shown -- that is the timer's job.
    root.classList.add("tn-hidden");
    setInterval(() => {
      const top = nativeControlBar();
      if (top != null) root.style.bottom = Math.max(GAP, window.innerHeight - top + GAP) + "px";
    }, 300);
  }

  start();
})();
