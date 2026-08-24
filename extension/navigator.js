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

  // ------------------------------------------------- calibration persistence
  // A calibration belongs to ONE recording: the same stage on a different
  // site, or a different cut on the same site, has a different timeline and
  // the saved numbers mean nothing there. So everything is keyed by
  // (stage, site) and fingerprinted by the recording's duration -- cheap,
  // available before playback starts, and different cuts differ by minutes
  // where the same asset re-opened differs by at most a second or two.
  //
  // Two tiers, local first:
  //   1. chrome.storage.local -- this browser's own past calibrations.
  //   2. calibrations.json -- the SHARED store, crowdsourced from every
  //      viewer: fetched fresh from the repo (so new contributions arrive
  //      without an extension update), falling back to the bundled snapshot.
  const SITE = location.hostname;
  const SHARED_CAL_URL =
    "https://raw.githubusercontent.com/elliebaker3/tour-scraper/main/extension/data/calibrations.json";
  // Stage bundles (index.json + profile-*.json / stage-*.json) follow the
  // same two-tier rule as calibrations above: fetched fresh from the repo so
  // a newly-published stage -- or a whole new race, like the Vuelta -- shows
  // up next reload with no extension update, falling back to whatever was
  // bundled at install time if the network (or the host permission) isn't
  // there.
  const REMOTE_DATA_BASE =
    "https://raw.githubusercontent.com/elliebaker3/tour-scraper/main/extension/data/";
  // Contributing back, in preference order:
  //   1. COLLECTOR_URL -- the Cloudflare Worker in worker/. It holds the
  //      GitHub token (a token shipped inside an extension is readable by
  //      anyone who unpacks it, so it can never live here) and commits on the
  //      viewer's behalf: no account, no tab, nothing to click through.
  //   2. the issue form -- used when no collector is deployed or it can't be
  //      reached. Needs a GitHub login, which is the barrier the collector
  //      exists to remove.
  // Blank here would mean fallback-only; this is the deployed collector.
  const COLLECTOR_URL = "https://tour-calibrations.tournavigator.workers.dev";
  const SHARE_ISSUE_URL = "https://github.com/elliebaker3/tour-scraper/issues/new";
  // Session telemetry goes to a SEPARATE, private store. Calibrations have to
  // be public for the extension to read them back without credentials; how one
  // person moved through a recording does not, and should not be.
  const SESSION_URL = COLLECTOR_URL ? COLLECTOR_URL + "/session" : "";
  // Same asset re-opened: duration identical to within ~2s. Different cut:
  // minutes apart. 30s splits those cleanly.
  const DUR_TOL_SEC = 30;
  // Sprints and climbs are part of the elevation graphic, so they default on.
  // The race-event markers all default OFF -- an empty bar is the calm default,
  // and the viewer opts into whichever kind they want to see. History and stats
  // were dropped entirely.
  // Filter toggles. Crashes, attacks and catches each have their own switch;
  // "Significant event" is an umbrella that shows any race-event beat (those
  // three plus scenery) in one go. A marker shown by either its own switch or
  // the umbrella keeps its category colour. Contenders (persons of interest) are
  // their own switch, marked with a star.
  const KOM_RED = "#b91c1c";
  const KOM_COLOR = { HC: KOM_RED, "Cat 1": KOM_RED, "Cat 2": KOM_RED,
                      "Cat 3": KOM_RED, "Cat 4": KOM_RED };

  const CATEGORIES = {
    sprint:          { label: "Sprints",           color: "#22c55e", on: true },
    kom:             { label: "Climbs",            color: KOM_RED,   on: true },
    poi:             { label: "Contenders",        color: "#38bdf8", on: false },
    crash:           { label: "Crashes",           color: "#e5484d", on: false },
    breakaway_start: { label: "Attacks",           color: "#f5a524", on: false },
    breakaway_end:   { label: "Catches",           color: "#8b7cf6", on: false },
    significant:     { label: "Significant event", color: "#cbd5e1", on: false },
    // Yours, not the race's: moments you flagged while watching. Last in the
    // list because it is the only kind that comes from you rather than from
    // the ticker, and on by default because a marker you placed yourself is
    // never a surprise.
    favourite:       { label: "My moments",        color: "#f472b6", on: true },
  };

  // The race-event guidepost kinds, the word shown for each (the KIND of moment,
  // never who -- spoiler-light) and its colour. Scenery has no switch of its
  // own; it only appears under the Significant-event umbrella.
  const SIGNIFICANT_WORD = {
    crash: "crash", breakaway_start: "attack",
    breakaway_end: "caught", scenic: "scenery",
  };
  const EVENT_COLOR = {
    crash: "#e5484d", breakaway_start: "#f5a524",
    breakaway_end: "#8b7cf6", scenic: "#30a46c",
  };

  // Every climb is the same deep red, whatever its grade. Shading by category
  // put four more colours on a bar that already carries sprints, contenders
  // and event markers, and the grade is on the badge anyway -- the colour was
  // saying a second time what the label already said, at the cost of the
  // climbs no longer reading as one kind of thing.

  // Contenders are sky blue rather than gold: the elevation profile is drawn
  // in the race's own yellow, so a gold star sat on top of it read as part of
  // the terrain instead of as a marker over it.
  // Persons of interest (contenders for each jersey) are marked when involved
  // in an event, but the rider's identity is NEVER shown -- that would spoil
  // what's about to happen. The names live in the data only to place the
  // markers; nothing about who or what is rendered anywhere in the UI.

  // Vertical padding inside the bar, in px: headroom above the highest point so
  // the peak doesn't jam against the top edge (and leaves room for the markers
  // that sit up there), and a sliver below the lowest.
  const PROFILE_TOP_PAD = 30;
  const PROFILE_BOT_PAD = 2;

  // Horizontal margin at the END of the bar. The finish is the one marker
  // guaranteed to sit at the extreme right, and its name would otherwise be
  // pinned against the edge. Everything positional maps into (width - this),
  // playhead included, so the drawing area shrinks as one piece and the
  // playhead still lines up with the recording.
  const PROFILE_RIGHT_PAD = 30;

  let bundle = null;
  let bundle_index = null;
  let bundle_selection_ok = false;
  let video = null;
  let anchors = [];           // [{ tUtcMs, videoSec, label }]
  let root = null;
  let hoverEl = null;         // readout element, re-attached after each render
  let sharedCal = null;       // calibrations.json content, fetched once at start
  let sharedCalReady = null;  // promise for that fetch, so restore can await it
  let restoredFrom = "";      // "" | "this browser" | "shared store" -- for the note
  /* Transient feedback -- a reading landing, or refusing to. It rides in the
   * diag line rather than a status field of its own: the panel had a strip of
   * white text beside the buttons that spent most of its life restating what
   * the diag said one line below. Errors still have to be visible, so they
   * appear there briefly and then clear. */
  let flashText = "";
  let flashUntil = 0;
  const flash = (msg, ms = 9000) => {
    flashText = msg;
    flashUntil = Date.now() + ms;
    console.log("[TourNavigator]", msg);
    // Draw it now rather than waiting for the next tick. The diag is rebuilt
    // on a 500ms timer, so feedback on a reading -- including a refusal --
    // could sit invisible for half a second after the click that caused it.
    if (root && bundle) render();
  };
  const flashNow = () => (Date.now() < flashUntil ? flashText : "");
  let triedRestore = false;   // restore runs once, when the video first appears
  let anchoredToVideo = false;// the default model is settled once, likewise
  const enabled = Object.fromEntries(
    Object.entries(CATEGORIES).map(([k, v]) => [k, v.on]));

  // ---------------------------------------------------------------- clock

  /** Map race UTC (ms) -> seconds into the recording, from the anchors.
   *  0 anchors: unusable. 1 anchor: offset at the default rate. 2+: fit both
   *  offset and rate, which absorbs ad breaks and a late broadcast join. */
  /* Calibration is a single explicit transform:
   *     videoSec = offsetSec + rate * (tUtcMs - refMs)/1000
   * Anchors are one way to derive it; dragging the bar is another. Keeping it
   * as one object means a manual nudge is exact and inspectable rather than a
   * fudge layered on top of an anchor pair. */
  let cal = null;   // {refMs, offsetSec, rate}

  /* Readings the viewer has given (km-to-go pinned against a recording spot).
   * One sets the offset at the default rate; two far enough apart fit the rate
   * itself, which is the accurate end state. */
  function pins() { return anchors.filter((a) => a.kind); }

  // Below this baseline between two readings, rate cannot be fitted reliably:
  // each km-to-go reading carries ~45s of rounding, and dividing that by a
  // short span turns it into a wild slope. Under it, offset only.
  const MIN_RATE_BASELINE_SEC = 20 * 60;

  /* What a broadcast looks like before anyone has calibrated it, per site.
   *
   * These two numbers ARE the uncalibrated model, and they are not universal:
   *
   *   rate    recording seconds per second of racing. Below 1 when the feed
   *           cuts away to adverts, since race time keeps running while the
   *           recording does not show it. Peacock measured 0.92 from its
   *           flag-drop and finish pins -- roughly 20 minutes of a stage
   *           missing. A public broadcaster carries no commercial breaks
   *           during live sport, so its feed runs about 1:1 and assuming
   *           0.92 would drift it by an hour across a stage.
   *
   *   preroll how far into the recording the flag drops. Peacock's replays
   *           open with about an hour of build-up. A live stream has no such
   *           thing -- it begins wherever you tuned in -- so there is nothing
   *           to skip.
   *
   * Anything not listed falls back to the Peacock shape, which is the safer
   * guess for a commercial broadcaster and is what most of them are. */
  const SITE_PROFILES = {
    "www.peacocktv.com": { rate: 0.92, preroll: 3600, ads: true,  label: "Peacock" },
    "npo.nl":            { rate: 1.00, preroll: 0,    ads: false, label: "NPO" },
    "www.npo.nl":        { rate: 1.00, preroll: 0,    ads: false, label: "NPO" },
    "nos.nl":            { rate: 1.00, preroll: 0,    ads: false, label: "NOS" },
    "www.nos.nl":        { rate: 1.00, preroll: 0,    ads: false, label: "NOS" },
  };
  const SITE_PROFILE = SITE_PROFILES[SITE] ||
    { rate: 0.92, preroll: 3600, ads: true, label: SITE };

  const DEFAULT_RATE = SITE_PROFILE.rate;

  /** Race time (ms) that a reading implies sits at recording second 0, for a
   *  given rate: videoSec = rate * (t - zero)/1000. */
  const impliedZeroMs = (a, rate) => a.tUtcMs - (a.videoSec * 1000) / rate;

  /* One reading gives the OFFSET at the default rate -- the best a single point
   * can do. Two or more readings, far enough apart, also give the RATE, from a
   * least-squares fit of recording-second against race-time across all
   * readings, which averages out their rounding. */
  function calFromAnchors() {
    const p = pins();
    if (!p.length) return null;
    if (p.length === 1) {
      return { refMs: p[0].tUtcMs, offsetSec: p[0].videoSec, rate: DEFAULT_RATE };
    }
    const xs = p.map((a) => a.tUtcMs / 1000);      // race seconds
    const ys = p.map((a) => a.videoSec);           // recording seconds
    const baseline = Math.max(...xs) - Math.min(...xs);
    const refMs = p[0].tUtcMs;
    if (baseline < MIN_RATE_BASELINE_SEC) {
      // Too close to trust a slope: hold the default rate, offset from median.
      const z = p.map((a) => impliedZeroMs(a, DEFAULT_RATE)).sort((a, b) => a - b);
      return { refMs: z[z.length >> 1], offsetSec: 0, rate: DEFAULT_RATE };
    }
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    let rate = den ? num / den : 1.0;
    rate = Math.max(0.5, Math.min(1.5, rate));     // reject nonsense slopes
    const offsetSec = my - rate * (mx - refMs / 1000);
    return { refMs, offsetSec, rate };
  }

  /** Recording-second error of each reading against the fitted line -- how much
   *  the readings disagree once rate is accounted for. */
  function pinResidualsSec() {
    const p = pins();
    if (p.length < 2 || !cal) return [];
    return p.map((a) => a.videoSec - utcToVideo(a.tUtcMs));
  }


  /* The clock, in two layers that coexist rather than replace each other.
   *
   * GLOBAL -- one universal rate across the whole race. With no readings it
   * is the broadcast's own shape: about an hour of build-up before the flag,
   * then 0.92x, since roughly 8% of race time goes to ad breaks. Readings
   * refine that rate by least-squares fit (calFromAnchors), exactly as they
   * always did. This governs everywhere by default.
   *
   * LOCAL -- inside one ad-bracketed interval only. Between two ad breaks the
   * broadcast runs at real time, so a reading taken in that interval is an
   * exact anchor and time runs 1x FROM IT to the interval's edges. At those
   * edges the global rate resumes.
   *
   * The local layer is therefore only as real as the break boundaries, and it
   * stays dormant until they are actually detected (see adBreaks /
   * detectAdBreaks). That is deliberate: an interval with invented edges
   * would drift silently, which is the failure this whole model exists to
   * avoid. With no breaks detected the panel behaves exactly as the global
   * model alone -- no worse than before, and never speculatively better.
   */
  const BROADCAST_PREROLL_SEC = SITE_PROFILE.preroll;

  /** The no-readings model: race start sits at the preroll, then 0.92x. */
  function defaultCal() {
    // Watching it happen: the far end of the DVR window is the race as of
    // now, so the clock needs no assumption about where the flag dropped in
    // the recording. Anchor the LIVE EDGE to the present -- not the viewer's
    // own position, which would read as the live edge wherever they had
    // scrubbed to and make every earlier moment look like the present.
    const startMs0 = Date.parse(bundle?.coverage?.race_start_utc || "");
    const finishMs0 = Date.parse(bundle?.coverage?.race_finish_utc || "");
    const edge = liveEdge(video);
    if (edge != null && isFinite(startMs0)) {
      const live = { refMs: Date.now(), offsetSec: edge,
                     rate: DEFAULT_RATE, source: "live" };
      // Only if it actually lands the race inside this recording. Anchoring
      // the present to the present is right for a stage happening NOW, and
      // nonsense for one that finished yesterday -- which is what a replay,
      // or simply the wrong stage in the picker, looks like. Getting that
      // wrong draws an empty bar with nothing to say why, so the overlap is
      // checked rather than assumed.
      const span = spanOf(video);
      const at = (t) => live.offsetSec + live.rate * (t - live.refMs) / 1000;
      const a = at(startMs0), b = at(isFinite(finishMs0) ? finishMs0 : startMs0);
      if (Math.min(a, b) < span && Math.max(a, b) > 0) return live;
    }
    if (!isFinite(startMs0)) return null;
    return { refMs: startMs0, offsetSec: BROADCAST_PREROLL_SEC,
             rate: DEFAULT_RATE, source: "default" };
  }

  /* Ad-break boundaries, in recording seconds, ascending. Empty until the
   * player's own scrub bar yields them (detectAdBreaks). Everything local
   * keys off this list, so an empty list means the global model runs alone --
   * which is the point: no invented intervals. */
  /* Moments the viewer flagged, as recording seconds. Kept with the
   * calibration for this recording, so they come back on reload. Not shared:
   * a reading describes the RECORDING and helps everyone watching it, whereas
   * a flagged moment describes what one person found interesting. */
  let favourites = [];

  /* What was actually watched.
   *
   * Two things get recorded, because they answer two different questions:
   *
   *   coverage  seconds spent on each kilometre of the ROUTE. Answers "which
   *             parts of a stage do people watch or rewatch". Accumulated, so
   *             watching a climb twice counts twice.
   *   events    seeks, with where from and where to. Answers "how do people
   *             navigate" -- which the coverage alone cannot, since it cannot
   *             tell a skipped hour from one nobody reached.
   *
   * Sampling rides on the render tick, which runs whether or not the panel is
   * on screen, so a viewer who never opens the bar is still measured. Progress
   * is only credited when the playhead advances at roughly playback speed; a
   * jump is a seek, not sixty seconds of viewing.
   */
  const SESSION = {
    id: (crypto.randomUUID ? crypto.randomUUID()
                           : String(Date.now()) + Math.random().toString(16).slice(2)),
    started: new Date().toISOString(),
    coverage: {},          // km-to-go (rounded) -> seconds watched
    events: [],            // { at, kind, fromSec, toSec, fromKm, toKm }
    sampled: 0,
  };
  let lastSampleSec = null;
  let lastSampleAt = 0;
  let sessionDirty = false;

  const MAX_SESSION_EVENTS = 500;

  function sampleWatching() {
    const now = Date.now();
    const at = video?.currentTime;
    if (!(at >= 0) || !spanOf(video)) { lastSampleSec = null; return; }
    const wall = (now - lastSampleAt) / 1000;
    const moved = lastSampleSec == null ? null : at - lastSampleSec;
    lastSampleAt = now;
    const prev = lastSampleSec;
    lastSampleSec = at;
    if (moved == null || wall <= 0 || wall > 5) return;   // first sample, or we were asleep

    // Advancing at about playback speed: count it as watched.
    if (moved > 0 && moved <= wall * 3) {
      const kmto = kmToGoAt(at);
      if (kmto != null) {
        const bucket = String(Math.round(kmto));
        SESSION.coverage[bucket] = +((SESSION.coverage[bucket] || 0) + moved).toFixed(2);
        SESSION.sampled++;
        sessionDirty = true;
      }
      return;
    }
    // Anything else is a jump. Backwards, or forwards faster than play allows.
    if (Math.abs(moved) > Math.max(3, wall * 3)) {
      if (SESSION.events.length < MAX_SESSION_EVENTS) {
        SESSION.events.push({
          at: new Date(now).toISOString(),
          kind: moved > 0 ? "skip" : "rewind",
          fromSec: +prev.toFixed(1), toSec: +at.toFixed(1),
          fromKm: kmToGoAt(prev), toKm: kmToGoAt(at),
        });
      }
      sessionDirty = true;
    }
  }

  /** Km-to-go at a recording position, or null if the clock cannot say. */
  function kmToGoAt(sec) {
    const ms = videoToUtc(sec);
    if (ms == null) return null;
    const s = series();
    if (!s.length) return null;
    if (ms <= s[0].t || ms >= s[s.length - 1].t) return null;
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= ms) lo = mid; else hi = mid;
    }
    return +s[lo].kmto.toFixed(1);
  }

  async function sendSession(final) {
    if (!SESSION_URL || !sessionDirty) return;
    if (!Object.keys(SESSION.coverage).length && !SESSION.events.length) return;
    sessionDirty = false;
    const body = JSON.stringify({
      schema: 1,
      session_id: SESSION.id,
      started: SESSION.started,
      ended: new Date().toISOString(),
      final: !!final,
      stage: bundle?.stage?.stage ?? null,
      date: bundle?.stage?.date ?? null,
      site: SITE,
      duration_sec: Math.round(spanOf(video) * 10) / 10,
      coverage: SESSION.coverage,
      events: SESSION.events,
      extension_version: (() => {
        try { return chrome.runtime.getManifest().version; } catch (_) { return null; }
      })(),
    });
    try {
      // keepalive so the last write survives the tab closing, which is exactly
      // when a session is complete and most worth having.
      await fetch(SESSION_URL, { method: "POST", keepalive: true,
                                 headers: { "Content-Type": "application/json" }, body });
    } catch (_) { sessionDirty = true; }
  }

  let adBreaks = [];

  /* Above this a "group of identical ticks" is page furniture rather than ad
   * markers. Set high on purpose: guessing this number low is what broke
   * detection before, and the cost of the two errors is not symmetric -- too
   * high merely risks a wrong set that __tnAdDebug can diagnose, too low
   * silently discards the right one. */
  const MAX_PLAUSIBLE_BREAKS = 80;

  /** The ad-bracketed interval containing a recording second: [lo, hi].
   *  Null when there are no breaks, so callers fall through to global. */
  function intervalAt(sec) {
    if (!adBreaks.length || !isFinite(sec)) return null;
    let lo = 0, hi = spanOf(video) || Infinity;
    for (const b of adBreaks) {
      if (b <= sec) lo = b;
      else { hi = b; break; }
    }
    return { lo, hi };
  }

  /** The reading that governs an interval, if one was taken inside it. Where
   *  several were, the nearest to the interval wins -- they should agree, and
   *  picking deterministically beats averaging anchors that each claim to be
   *  exact. */
  function localAnchor(sec) {
    const iv = intervalAt(sec);
    if (!iv) return null;
    const inside = pins().filter((a) => a.videoSec >= iv.lo && a.videoSec <= iv.hi);
    if (!inside.length) return null;
    inside.sort((a, b) => Math.abs(a.videoSec - sec) - Math.abs(b.videoSec - sec));
    return { anchor: inside[0], ...iv };
  }

  const globalUtcToVideo = (tUtcMs) =>
    cal ? cal.offsetSec + cal.rate * (tUtcMs - cal.refMs) / 1000 : null;
  const globalVideoToUtc = (sec) =>
    cal && cal.rate ? cal.refMs + ((sec - cal.offsetSec) / cal.rate) * 1000 : null;

  function utcToVideo(tUtcMs) {
    const g = globalUtcToVideo(tUtcMs);
    if (g == null) return null;
    // Does a reading's own interval claim this moment? Ask where the global
    // model puts it, then check that interval for an anchor; if one governs,
    // 1x from the anchor wins inside the interval's edges.
    const loc = localAnchor(g);
    if (loc) {
      const v = loc.anchor.videoSec + (tUtcMs - loc.anchor.tUtcMs) / 1000;
      if (v >= loc.lo && v <= loc.hi) return v;
    }
    return g;
  }

  function videoToUtc(sec) {
    const loc = localAnchor(sec);
    if (loc) return loc.anchor.tUtcMs + (sec - loc.anchor.videoSec) * 1000;
    return globalVideoToUtc(sec);
  }

  /** The rate the panel reports: the global one, since that is what governs
   *  everywhere outside a bracketed interval. */
  function effectiveRate() {
    return cal ? cal.rate : DEFAULT_RATE;
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
   *  The recording is longer than the race: an hour or so of build-up before
   *  km 0, and coverage past the line. Those stretches get NO elevation --
   *  nobody was riding, so there is nothing to draw. They used to be filled
   *  flat at the start and finish altitudes, which stretched the silhouette
   *  across the whole bar and made the race look like it spanned the entire
   *  broadcast. Leaving them empty is what puts the shape where the race
   *  actually is, so the profile begins at the flag drop and the playhead
   *  lines up with the player's own position. Gaps INSIDE the race are still
   *  bridged linearly. */
  function elevationAt(tMs) {
    const s = series();
    if (!s.length) return null;
    if (tMs <= s[0].t) return null;
    if (tMs >= s[s.length - 1].t) return null;
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
  function profilePath(width, height, plotW) {
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
    for (let px = 0; px <= plotW; px++) {
      const sec = (px / plotW) * spanOf(video);
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
  function profilePath(width, height, plotW) {
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
    for (let px = 0; px <= plotW; px++) {
      const sec = (px / plotW) * spanOf(video);
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


  /** Lite calibration: with no telemetry there is no race clock, so readings
   *  pin km-to-go straight onto recording seconds. Two or more, far apart,
   *  give a piecewise-linear map between distance and recording time --
   *  linear between neighbouring readings, extrapolated at the ends with the
   *  nearest segment's pace. One reading alone is NOT extrapolated: a lone
   *  pin plus a guessed speed would put the playhead somewhere confidently
   *  wrong, which is worse than not showing it. */
  function liteMap() {
    const p = pins()
      // A record saved before kmto was persisted still reconstructs exactly:
      // kmto is just the whole-kilometre midpoint correction applied to km.
      .map((a) => (typeof a.kmto === "number" ? a
        : { ...a, kmto: Number.isInteger(a.km) ? a.km + 0.5 : a.km }))
      .filter((a) => typeof a.kmto === "number")
      .sort((a, b) => a.videoSec - b.videoSec);
    if (p.length < 2) return null;
    return {
      kmtoAtSec(sec) {
        let i = 1;
        while (i < p.length - 1 && p[i].videoSec < sec) i++;
        const a = p[i - 1], b = p[i];
        const span = b.videoSec - a.videoSec;
        if (!span) return a.kmto;
        return a.kmto + (b.kmto - a.kmto) * ((sec - a.videoSec) / span);
      },
      secAtKmto(kmto) {
        const q = [...p].sort((a, b) => a.kmto - b.kmto);
        let i = 1;
        while (i < q.length - 1 && q[i].kmto < kmto) i++;
        const a = q[i - 1], b = q[i];
        const span = b.kmto - a.kmto;
        if (!span) return a.videoSec;
        return a.videoSec + (b.videoSec - a.videoSec) * ((kmto - a.kmto) / span);
      },
    };
  }

  /** The Peacock assumption, for a stage with no telemetry at all: the flag
   *  drops an hour into the recording, and the race then occupies its
   *  scheduled duration at 0.92x. That is enough to place the profile on the
   *  recording and to show where you are watching, without a single reading --
   *  the same two constants the full bundles default to. Readings replace it
   *  the moment there are two (liteMap), which is why the prompt still asks
   *  for them. */
  function defaultLiteMap() {
    const dur = spanOf(video);
    const sched = bundle?.stage?.scheduled_sec;
    const len = bundle?.stage?.length_km;
    if (!dur || !sched || !len) return null;
    const start = Math.min(BROADCAST_PREROLL_SEC, dur * 0.25);
    const span = Math.min(sched * DEFAULT_RATE, dur - start);
    if (span <= 0) return null;
    return {
      __default: true,
      kmtoAtSec(sec) {
        const f = Math.max(0, Math.min(1, (sec - start) / span));
        return len - f * len;
      },
      secAtKmto(kmto) {
        const f = Math.max(0, Math.min(1, (len - kmto) / len));
        return start + f * span;
      },
    };
  }

  /** Lite stages: a velowire distance/elevation profile and route markers.
   *  The x-axis is DISTANCE, not recording time -- the profile shape is real
   *  regardless of any clock. Uncalibrated it is a reference card; with two
   *  or more km-to-go readings (liteMap) it gains a playhead, click-to-seek
   *  and clickable markers, moving nonlinearly along the distance axis. */
  function renderLite() {
    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const plotW = Math.max(10, width - PROFILE_RIGHT_PAD);
    const height = bar.clientHeight || 78;
    const prof = bundle.profile;
    const len = bundle.stage?.length_km || Math.max(...prof.map((p) => p.km)) || 1;

    const alts = prof.map((p) => p.alt);
    const loA = Math.min(...alts), hiA = Math.max(...alts);
    const rangeA = Math.max(1, hiA - loA);
    const y = (alt) => height - ((alt - loA) / rangeA) * (height - PROFILE_TOP_PAD - PROFILE_BOT_PAD) - PROFILE_BOT_PAD;

    const pinned = liteMap();                 // from readings, if there are two
    const lm = pinned || defaultLiteMap();     // else the Peacock assumption
    const dur = spanOf(video);
    // The status line is otherwise written once at load, before the player has
    // reported a duration -- at which point there is no assumption to describe
    // yet and it settles on "not calibrated", contradicting the diag. With no
    // readings there is no status worth preserving, so keep it current.
    // The prompt asks for readings until there ARE readings -- the assumption
    // is a starting point, not a substitute for one. The bar always shows.
    root.classList.toggle("tn-lite-setup", !pinned);

    /* Which axis the bar is drawn on.
     *
     * Uncalibrated there is only one honest choice: DISTANCE, spanning the
     * whole bar, because nothing yet relates the route to the recording.
     *
     * Once readings give a distance<->time map the bar becomes a RECORDING
     * timeline like a full bundle's, and the profile occupies only the part
     * of the recording the race occupies -- the build-up before the flag and
     * anything past the line stay empty. That is what makes the shape line up
     * with the player's own position instead of merely being the right shape. */
    const timeAxis = !!(lm && dur);
    const x = timeAxis
      ? (km) => (Math.max(0, Math.min(dur, lm.secAtKmto(len - km))) / dur) * plotW
      : (km) => (km / len) * plotW;

    // On a time axis the silhouette must not be closed back to the bar's
    // corners, or it would stretch across the empty build-up; it closes at
    // its own first and last column instead.
    const pts = prof.map((p) => [x(p.km), y(p.alt)]);
    const x0 = timeAxis ? pts[0][0] : 0;
    const x1 = timeAxis ? pts[pts.length - 1][0] : width;
    let d = `M ${x0.toFixed(1)} ${height} L `;
    d += pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(" L ");
    d += ` L ${x1.toFixed(1)} ${height} Z`;

    const routeMarks = [];
    for (const m of bundle.markers || []) {
      const mx = x(m.km);
      const altAt = prof.reduce((best, p) =>
        Math.abs(p.km - m.km) < Math.abs(best.km - m.km) ? p : best, prof[0]);
      const my = y(altAt.alt);
      const isKom = m.kind === "kom" || (m.kind === "finish" && m.cat);
      const catLabel = m.cat === "HC" ? "HC" : m.cat ? `Cat ${m.cat}` : null;
      const color = isKom ? (KOM_COLOR[catLabel] || "#ef4444")
                  : m.kind === "sprint" ? CATEGORIES.sprint.color : "#cbd5e1";
      const badge = m.kind === "finish" ? "🏁" : isKom ? (m.cat || "") : "S";
      const tip = `${m.label} · km ${m.km}`;
      const place =
        (mx < 16 ? " tn-rm-atleft" : mx > width - 16 ? " tn-rm-atright" : "");
      const sec = lm && dur
        ? Math.max(0, Math.min(dur, lm.secAtKmto(len - m.km))) : null;
      // Lite bundles come straight from velowire, whose label IS the name
      // ("Col du Noyer"), so it goes on the bar the same way.
      const nameTag = m.label
        ? `<span class="tn-rm-name">${escapeHtml(m.label)}</span>` : "";
      routeMarks.push(
        `<div class="tn-rm tn-rm-${m.kind}${m.kind === "finish" ? " tn-rm-finish" : ""}${place}"
              style="left:${mx.toFixed(1)}px;top:${my.toFixed(1)}px;--rm:${color}"
              ${sec != null ? `data-sec="${sec.toFixed(1)}"` : ""} title="${escapeHtml(tip)}">
           <span class="tn-rm-badge">${escapeHtml(badge)}</span>${nameTag}
         </div>`);
    }

    // Playhead only when the distance<->time map exists: its x is the km the
    // map says the race is at now, so it moves nonlinearly along the bar.
    let playhead = "";
    if (timeAxis && video) {
      // On a time axis the playhead is simply where the recording is -- no
      // round trip through distance, so it lines up with the player's own
      // position exactly rather than to within the map's resolution.
      playhead = `<div class="tn-playhead" style="left:${((video.currentTime / dur) * plotW).toFixed(1)}px"></div>`;
    }

    bar.innerHTML = `
      <svg class="tn-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="none">
        <path d="${d}" class="tn-profile"/>
      </svg>
      <div class="tn-routemarks">${routeMarks.join("")}</div>
      ${playhead}
      <span class="tn-alt tn-alt-hi">${Math.round(hiA)}m</span>
      <span class="tn-alt tn-alt-lo">${Math.round(loA)}m</span>
    `;
    bar.querySelectorAll(".tn-rm[data-sec]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (video) video.currentTime = parseFloat(el.dataset.sec);
      });
    });
    bar.appendChild(hoverEl);

    const clock = root.querySelector(".tn-clock");
    if (lm && dur && video) {
      const kmto = Math.max(0, Math.min(len, lm.kmtoAtSec(video.currentTime)));
      const g = gradientAt(len - kmto);
      const bits = [fmtToGo(kmto)];
      if (g != null) bits.push(g > 1.5 ? `climbing ${g.toFixed(1)}%`
                             : g < -1.5 ? `descending ${Math.abs(g).toFixed(1)}%`
                             : "flat");
      clock.textContent = bits.join(" · ");
      clock.className = "tn-clock" +
        (g == null ? "" : g > 1.5 ? " tn-up" : g < -1.5 ? " tn-down" : "");
    } else {
      clock.textContent = `${len} km`;
      clock.className = "tn-clock";
    }
    root.querySelector(".tn-diag").textContent = [
      `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"})`,
      "profile only (no live capture)",
      "elevation: velowire.com",
      clockSummary(),
      bundle.__selection || "",
      flashNow(),
    ].filter(Boolean).join(" · ");
  }

  function render() {
    if (!root || !bundle) return;
    if (bundle.__kind === "profile") { renderLite(); return; }
    const dur = spanOf(video);

    // Until it is calibrated there is nothing honest to draw: the profile only
    // means something once every position on the bar is a known moment of the
    // race. Showing a shape before then invites reading positions off it that
    // are not real, which is exactly how "the elevation doesn't line up" kept
    // happening. So the panel is the setup prompt and nothing else.
    // The prompt now rides ALONGSIDE the bar rather than replacing it: with a
    // stated default there is always something honest to draw, but the viewer
    // still needs telling how to make it exact. It retires once a reading
    // exists. Nothing can be drawn at all without a player or a race start,
    // and that case still owns the panel.
    const ready = !!(cal && dur);
    root.classList.toggle("tn-needs-setup", !ready || !pins().length);
    root.classList.toggle("tn-no-clock", !ready);
    const note = root.querySelector(".tn-setup-note");
    if (!ready) {
      note.textContent = dur ? "" : "waiting for the player…";
      root.querySelector(".tn-clock").textContent = "not calibrated";
      root.querySelector(".tn-diag").textContent =
        `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"}) · ` +
        `${bundle.__selection || ""}`;
      return;
    }
    note.textContent = "";

    const bar = root.querySelector(".tn-bar");
    const width = bar.clientWidth || 900;
    const plotW = Math.max(10, width - PROFILE_RIGHT_PAD);
    const height = bar.clientHeight || 78;

    const { segs, loA, hiA } = profilePath(width, height, plotW);
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
      const x = (sec / dur) * plotW;
      const y = m.alt != null ? yForAlt(m.alt) : height / 2;
      const isKom = m.kind === "kom";
      const color = isKom ? (KOM_COLOR[m.cat] || "#ef4444") : CATEGORIES.sprint.color;
      const badge = isKom ? (m.finish ? "🏁" : (m.cat || "").replace("Cat ", "")) : "S";
      // Prefer the real name where one is known (velowire supplies "Col du
      // Noyer" where ASO's route data only grades it "Climb — Cat 1"), with
      // the grade kept alongside since that is what the badge shows.
      const tip = (m.name ? `${m.name} · ${m.label}` : m.label) +
                  (m.kmto != null ? ` · ${m.kmto} km to go · ${m.alt}m` : "");
      // Keep the badge fully inside the bar. It normally floats above the dot,
      // but summits sit near the top, so flip it below when there isn't room;
      // and shift it inward at the very edges so it is never clipped.
      // Badge and name always sit ABOVE the dot -- alternating above and below
      // made a row of climbs read as two staggered rows. The bar carries extra
      // headroom (PROFILE_TOP_PAD) so even a summit near the top has room.
      const place =
        (x < 16 ? " tn-rm-atleft" : x > width - 16 ? " tn-rm-atright" : "");
      // The name is drawn ON the bar, not left in the tooltip: a tooltip that
      // needs a 6px dot hovered exactly is not a label you can read at a
      // glance, which is the whole point of naming a climb.
      const nameTag = m.name
        ? `<span class="tn-rm-name">${escapeHtml(m.name)}</span>` : "";
      routeMarks.push(
        `<div class="tn-rm tn-rm-${m.kind}${m.finish ? " tn-rm-finish" : ""}${place}"
              style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--rm:${color}"
              data-sec="${sec.toFixed(1)}" title="${escapeHtml(tip)}">
           <span class="tn-rm-badge">${escapeHtml(badge)}</span>${nameTag}
         </div>`);
    }

    // Flagged moments, drawn from the recording position they were taken at
    // rather than through the clock: the viewer marked a spot in the
    // RECORDING, and that spot should not move if the calibration is later
    // refined.
    const favMarks = [];
    if (enabled.favourite) {
      for (const f of favourites) {
        if (!(f.videoSec >= 0 && f.videoSec <= dur)) continue;
        const fx = (f.videoSec / dur) * plotW;
        favMarks.push(
          `<div class="tn-marker tn-fav-mark" data-sec="${f.videoSec.toFixed(1)}"
                style="left:${fx.toFixed(1)}px;background:${CATEGORIES.favourite.color}"
                title="Your flagged moment"></div>`);
      }
    }

    const markers = [];
    for (const g of bundle.guideposts) {
      const word = SIGNIFICANT_WORD[g.category];
      if (!word) continue;                         // not a race-event kind
      // Shown by its own switch (crash/attack/catch) or the umbrella. Its own
      // switch colours it by kind; the umbrella alone shows it in one neutral
      // colour -- the umbrella isn't a colour-coded view.
      const own = enabled[g.category];
      if (!own && !enabled.significant) continue;
      const color = own ? EVENT_COLOR[g.category] : CATEGORIES.significant.color;
      const sec = utcToVideo(Date.parse(g.t_utc));
      if (sec == null || sec < 0 || sec > dur) continue;
      const x = (sec / dur) * plotW;
      markers.push(
        `<div class="tn-marker" style="left:${x.toFixed(1)}px;background:${color}"
              data-sec="${sec.toFixed(1)}" title="${word}"></div>`);
    }

    // Contenders: a STAR on the elevation curve, formatted like the climb
    // markers (a dot on the line with a badge), for any person-of-interest
    // event. Deliberately NO tooltip: revealing who or what happens is a
    // spoiler. Clicking seeks to it so you can watch it unfold yourself.
    const poiMarks = [];
    if (enabled.poi) {
      for (const m of bundle.special_markers || []) {
        const sec = utcToVideo(Date.parse(m.t_utc));
        if (sec == null || sec < 0 || sec > dur) continue;
        const x = (sec / dur) * plotW;
        const alt = altAtRaceMs(Date.parse(m.t_utc));
        const y = alt != null ? yForAlt(alt) : height / 2;
        const place =
          (x < 16 ? " tn-rm-atleft" : x > width - 16 ? " tn-rm-atright" : "");
        poiMarks.push(
          `<div class="tn-poi tn-rm${place}" data-sec="${sec.toFixed(1)}"
                style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--rm:${CATEGORIES.poi.color}">
             <span class="tn-rm-badge">★</span>
           </div>`);
      }
    }

    let heat = "";
    for (const s of bundle.intensity || []) {
      const sec = utcToVideo(Date.parse(s.t_utc));
      if (sec == null || sec < 0 || sec > dur) continue;
      const x = (sec / dur) * plotW;
      const w = Math.max(1, (s.window_min * 60 / dur) * plotW);
      heat += `<div class="tn-heat" style="left:${x.toFixed(1)}px;width:${w.toFixed(1)}px;
                opacity:${(s.normalised * 0.75).toFixed(2)}"></div>`;
    }

    const playX = (video.currentTime / dur) * plotW;
    bar.innerHTML = `
      <div class="tn-heatwrap">${heat}</div>
      <svg class="tn-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="none">
        ${paths}
      </svg>
      <div class="tn-markers">${markers.join("")}${favMarks.join("")}</div>
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

    root.querySelector(".tn-diag").textContent = [
      `stage ${bundle.stage?.stage ?? "?"} (${bundle.stage?.date ?? "?"})`,
      `rate ${effectiveRate().toFixed(3)}×`,
      adBreaks.length ? `${adBreaks.length} ad breaks · 1× inside the calibrated one`
                      : "no ad breaks found — global rate only",
      clockSummary(),
      bundle.__selection || "",
      flashNow(),
    ].filter(Boolean).join(" · ");
  }

  /** Altitude at a race time (ms), from the nearest timed profile point -- so a
   *  contender marker can sit on the elevation curve, like the climb markers. */
  function altAtRaceMs(ms) {
    let best = null, gap = Infinity;
    for (const p of bundle.profile) {
      if (!p.t) continue;
      const g = Math.abs(Date.parse(p.t) - ms);
      if (g < gap) { best = p; gap = g; }
    }
    return best ? best.alt : null;
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
    if (!bundle?.profile?.length || !cal || !spanOf(video)) return null;
    const target = frac * spanOf(video);
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
        <button class="tn-collapse" title="Hide">–</button>
      </div>
      <div class="tn-setup">
        <span class="tn-setup-ask">Pause where the broadcast shows
          <strong>km to go</strong> and type it here (then add a second reading
          far away, for accuracy):</span>
        <input class="tn-togo-km" size="5" placeholder="42" inputmode="decimal">
        <span class="tn-setup-unit">km to go</span>
        <button class="tn-togo-set" title="Calibrate — and contribute this reading
to the shared store, so anyone watching this same recording gets it
automatically. Sent anonymously: the stage, this site's name, the recording
length and the reading itself — never who you are or what else you watch.">Calibrate</button>
        <span class="tn-setup-note"></span>
      </div>
      <div class="tn-bar"></div>
      <div class="tn-diag"></div>
      <div class="tn-controls">
        <div class="tn-filters"></div>
        <div class="tn-anchors">
          <button class="tn-fav" title="Flag this moment so you can jump back to
it. Saved on this device with the rest of this recording's settings, and never
shared.">★ Flag moment</button>
          <input class="tn-togo-km2" size="5" placeholder="42" inputmode="decimal"
                 title="Refine: type another km-to-go reading from elsewhere in
the stage. The median of all readings is used.">
          <button class="tn-togo-set2" title="Add this reading — and contribute the
calibration to the shared store, so anyone watching this same recording gets it
automatically. Sent anonymously: the stage, this site's name, the recording
length and the readings themselves — never who you are or what else you
watch.">Add reading</button>
          <button class="tn-anchor-clear" title="Clear the calibration">reset</button>
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

    // Full bundle: every position on the bar is a recording time, so a click
    // is a seek. Lite bundle: x is distance, so the click goes through the
    // readings' distance<->time map instead -- and only once that map exists.
    bar.addEventListener("click", (ev) => {
      if (!spanOf(video)) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const plot = Math.max(10, rect.width - PROFILE_RIGHT_PAD);
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / plot));
      if (bundle.__kind === "profile") {
        const lm = liteMap();
        if (!lm) return;
        const len = bundle.stage?.length_km || 1;
        const sec = lm.secAtKmto(len - frac * len);
        video.currentTime = Math.max(0, Math.min(spanOf(video), sec));
        return;
      }
      if (!cal) return;
      video.currentTime = frac * spanOf(video);
    });

    bar.addEventListener("mousemove", (ev) => {
      const rect = bar.getBoundingClientRect();
      const plot = Math.max(10, rect.width - PROFILE_RIGHT_PAD);
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / plot));
      let bits = null;
      if (bundle.__kind === "profile") {
        // Lite: x is distance, so the readout is direct -- no clock involved.
        const len = bundle.stage?.length_km || 1;
        const km = frac * len;
        const near = bundle.profile.reduce((best, p) =>
          Math.abs(p.km - km) < Math.abs(best.km - km) ? p : best, bundle.profile[0]);
        bits = [`km ${km.toFixed(1)}`, `${fmtToGo(len - km)}`, `${Math.round(near.alt)}m`];
      } else {
        if (!cal) return;
        const s = sampleAt(frac);
        if (!s) { hoverEl.style.display = "none"; return; }
        bits = [fmtToGo(s.kmto), `${Math.round(s.alt)}m`];
        if (s.est) bits.push("est");
      }
      hoverEl.textContent = bits.join(" · ");
      hoverEl.style.display = "block";
      const x = frac * plot;
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

    // Reset clears the readings AND this recording's saved slot -- local
    // only. The shared store is other people's data; a bad entry there gets
    // superseded by the next share, not deleted from a viewer's browser.
    root.querySelector(".tn-fav").addEventListener("click", () => {
      const at = video?.currentTime;
      if (!(at >= 0)) { flash("no video"); return; }
      // Flagging the same spot twice is a mis-click, not two moments.
      if (favourites.some((f) => Math.abs(f.videoSec - at) < 5)) {
        flash("already flagged this moment");
        return;
      }
      favourites.push({ videoSec: at, at: new Date().toISOString() });
      favourites.sort((a, b) => a.videoSec - b.videoSec);
      saveCalibration();
      flash(`moment flagged at ${fmt(at)} · ${favourites.length} saved`);
      render();
    });

    root.querySelector(".tn-anchor-clear").addEventListener("click", () => {
      anchors = [];
      // Reset drops the READINGS, not the clock. The broadcast's stated
      // default is still a clock, so the bar keeps drawing rather than
      // blanking -- there is nothing to be gained by showing less than we
      // honestly know.
      cal = defaultCal();
      restoredFrom = "";
      clearLegacyStored();
      try {
        const key = calStoreKey();
        const dur = spanOf(video);
        chrome.storage.local.get([key], (r) => {
          const list = (r?.[key]?.recordings || []).filter((rec) =>
            !dur || Math.abs((rec.duration_sec || 0) - dur) > DUR_TOL_SEC);
          chrome.storage.local.set({ [key]: { v: 1, recordings: list } });
        });
      } catch (_) {}
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
      o.value = raceStageKey(s);
      // Stage numbers reset per race (Vuelta stage 1 != Tour stage 1), so a
      // mixed list needs the race named -- otherwise two identically-labelled
      // "Stage 1" options are indistinguishable except by date.
      const label = s.race && s.race !== "tdf"
        ? `${s.race[0].toUpperCase()}${s.race.slice(1)} Stage ${s.stage}` : `Stage ${s.stage}`;
      o.textContent = `${label} (${s.date})` + (s.kind === "profile" ? " — profile only" : "");
      if (bundle.stage && raceStageKey(s) === raceStageKey(bundle.stage)) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      try { chrome.storage.local.set({ tnPinnedStage: sel.value }, () => location.reload()); }
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
    if (!spanOf(video)) { flash("no video"); return; }
    if (!isFinite(km)) { flash("enter the kilometres to go, e.g. 42"); return; }

    const lite = bundle.__kind === "profile";
    const len = lite ? (bundle.stage?.length_km || 1) : routeLength();
    if (km < 0 || km > len) {
      flash(`${km} km to go is outside this stage (0–${len.toFixed(1)} km)`);
      return;
    }
    // A whole-kilometre graphic reads "42" from 42.0 down to 43.0, so the
    // midpoint is the best single estimate of what it meant.
    const exact = Number.isInteger(km) ? km + 0.5 : km;

    if (lite) {
      // No telemetry -> no race clock to pin against. A reading here pins
      // km-to-go DIRECTLY to a recording second; two or more, far apart,
      // make a piecewise-linear distance<->time map (see liteMap). Constant
      // speed between readings is crude on a mountain stage, so more
      // readings near the terrain changes tighten it.
      anchors = anchors.filter((a) => a.kind);
      anchors.push({ videoSec: video.currentTime, kind: "kmtogo", km,
                     kmto: exact, label: `${km} km to go` });
      saveCalibration();
      shareCalibration();
      render();
      const n = pins().length;
      flash(`${km} km to go — reading added · ${n} reading${n === 1 ? "" : "s"}` +
        (n < 2 ? " · add one far away to place the playhead" : ""));
      return;
    }

    const hit = timeAtKmToGo(exact);
    if (!hit) {
      flash(`no GPS coverage at ${km} km to go — try another point`);
      return;
    }

    const at = video.currentTime;
    anchors = anchors.filter((a) => a.kind);
    anchors.push({ tUtcMs: hit.tMs, videoSec: at, kind: "kmtogo", km,
                   label: `${km} km to go` });
    cal = calFromAnchors() || defaultCal();
    saveCalibration();
    shareCalibration();
    render();

    const p = pins();
    const parts = [`${km} km to go — reading added`];
    if (hit.est) parts.push("⚠ that stretch has no GPS — pace is inferred there");

    // Accuracy is now LOCAL, so the advice is too. A reading is exact where it
    // was taken and stays exact either side at real time until an ad break
    // intervenes; the way to be right somewhere else is a reading near there,
    // not more readings in general. (The old text asked for one "far away, to
    // fit the rate" -- that belonged to the single-global-rate model and is
    // actively misleading now.)
    if (p.length === 1) {
      parts.push(`offset set, rate assumed ${DEFAULT_RATE.toFixed(2)}×`);
      parts.push("▶ add a reading from far away (near the finish is ideal) " +
                 "to fit the rate exactly");
    } else {
      const xs = p.map((a) => a.tUtcMs / 1000);
      const baselineMin = (Math.max(...xs) - Math.min(...xs)) / 60;
      const res = pinResidualsSec().map(Math.abs);
      const worst = res.length ? Math.max(...res) : 0;
      parts.push(`${p.length} readings over ${baselineMin.toFixed(0)} min`);
      if (baselineMin < 20) {
        parts.push("⚠ readings too close to fix rate — spread them out, " +
                   "one early one late");
      } else {
        parts.push(`rate ${effectiveRate().toFixed(3)}× · fits to ±${worst.toFixed(0)}s`);
        if (worst > 90) {
          parts.push("⚠ readings disagree — re-check one, or reset and redo");
        }
      }
    }
    if (localAnchor(at)) parts.push("1× inside this ad break interval");
    flash(parts.join(" · "));
  }







  /** One phrase describing what the clock is currently doing. Folded into the
   *  diag line by render(), where it sits beside the rest of the assumptions
   *  instead of duplicating them in a second place. */
  function clockSummary() {
    const p = pins();
    if (!p.length) {
      // A lite stage has no race clock to default from, but it does have the
      // Peacock shape, so say what is assumed rather than "not calibrated".
      const assumed = cal || (bundle?.__kind === "profile" && defaultLiteMap());
      return assumed
        ? `assuming ${Math.round(BROADCAST_PREROLL_SEC / 60)} min build-up then ` +
          `${DEFAULT_RATE.toFixed(2)}×`
        : "not calibrated";
    }
    const restored = restoredFrom ? `restored from ${restoredFrom}, ` : "";
    if (bundle?.__kind === "profile") {
      return restored + (p.length < 2
        ? "1 reading — add one far away to place the playhead"
        : `${p.length} readings, steady-pace interpolation`);
    }
    if (p.length === 1) {
      return restored + `1 reading, rate ${DEFAULT_RATE.toFixed(2)}× assumed — ` +
        "add one far away to fit it";
    }
    const res = pinResidualsSec().map(Math.abs);
    const worst = res.length ? Math.max(...res) : 0;
    return restored +
      `${p.length} readings, fits to ±${worst.toFixed(0)}s`;
  }


  /* Persistence, second attempt. The first one was removed after stale
   * restores kept producing a wrong-looking bar -- but the actual fault was
   * the KEYING (one slot per stage number, shared across recordings), not
   * persistence itself. A calibration now belongs to one (stage, site,
   * duration-fingerprint) triple, so the failure mode "stage 15's numbers
   * applied to a different recording" cannot key-collide any more. The old
   * per-stage slot is still wiped on load so pre-rework leftovers never
   * resurface. */
  // Both storage tiers key on (year, stage, site) alone, which was fine while
  // the Tour was the only race this ever ran against -- year+stage was
  // unique. The Vuelta breaks that: its 2026 stage 14 and the Tour's 2026
  // stage 14 would land in the SAME slot, each one's readings silently
  // overwriting or auto-restoring onto the other's recording. Vuelta bundles
  // are tagged `race: "vuelta"` (see loadBundle's raceStageKey); Tour ones
  // carry no race at all, since they predate this and their keys must not
  // move -- real crowdsourced entries already live in the shared store and
  // in viewers' local storage under the un-prefixed "stage-N" form.
  const stageKey = () => {
    const race = bundle?.stage?.race;
    const prefix = race && race !== "tdf" ? `${race}-` : "";
    return `stage-${prefix}${bundle?.stage?.stage ?? "?"}`;
  };
  const calStoreKey = () =>
    `tnCal:v1:${(bundle?.stage?.date || "").slice(0, 4)}|${stageKey()}|${SITE}`;

  function clearLegacyStored() {
    try {
      chrome.storage?.local?.remove(STORAGE_KEY + ":" + stageKey());
    } catch (_) { /* storage is a convenience, not a requirement */ }
  }

  /** Everything worth knowing about this calibration of this recording --
   *  the anchors are what restore needs; the rest is context for the shared
   *  store (who else can use this? which asset was it? how was it derived?). */
  function calRecord() {
    let version = null;
    try { version = chrome.runtime.getManifest().version; } catch (_) {}
    return {
      schema: 1,
      stage: bundle?.stage?.stage ?? null,
      // Omitted entirely for the Tour rather than sent as "tdf": the worker
      // and the shared-store key both treat a missing race as the Tour, so
      // existing recordings (and older extension versions still submitting)
      // keep landing in the same slot they always have.
      ...(bundle?.stage?.race && bundle.stage.race !== "tdf" ? { race: bundle.stage.race } : {}),
      date: bundle?.stage?.date ?? null,
      site: SITE,
      duration_sec: Math.round(spanOf(video) * 10) / 10,
      airing_ms: bundle?.__airingMs ?? null,
      // kmto matters as much as km: it carries the whole-kilometre midpoint
      // correction, and on lite stages it is the only thing liteMap reads.
      anchors: pins().map((a) => ({ tUtcMs: a.tUtcMs, videoSec: a.videoSec,
                                    kind: a.kind, km: a.km, kmto: a.kmto,
                                    label: a.label })),
      // The interval edges travel WITH the readings. A reading alone restores
      // only the global rate; without the breaks that bracket it there is no
      // interval for it to govern, and the local layer silently would not
      // exist for the next viewer. They are a property of the recording, so
      // everyone watching this same cut shares them.
      ad_breaks: adBreaks.slice(),
      // Submitted, but never restored onto anyone else's bar -- see
      // applyRecord. Kept as bare positions with no note or label attached.
      favourites: favourites.map((f) => ({ videoSec: f.videoSec })),
      cal,
      saved_at: new Date().toISOString(),
      extension_version: version,
    };
  }

  /** Store (or update) this recording's calibration in chrome.storage.local.
   *  The value is a LIST of recordings for (stage, site): the same viewer may
   *  have both the live airing and a replay cut. Fingerprint match replaces;
   *  otherwise the new recording is appended. */
  function saveCalibration() {
    // Lite stages never have a `cal` -- their anchors ARE the calibration --
    // so the readings, not the transform, are what makes this worth storing.
    if (!spanOf(video)) return;
    if (!pins().length && !favourites.length) return;
    if (bundle?.__kind !== "profile" && !cal) return;
    const key = calStoreKey();
    try {
      chrome.storage.local.get([key], (r) => {
        const list = (r?.[key]?.recordings) || [];
        const dur = spanOf(video);
        const i = list.findIndex((rec) =>
          Math.abs((rec.duration_sec || 0) - dur) <= DUR_TOL_SEC);
        const rec = calRecord();
        if (i >= 0) list[i] = rec; else list.push(rec);
        chrome.storage.local.set({ [key]: { v: 1, recordings: list } });
      });
    } catch (_) { /* storage is a convenience, not a requirement */ }
  }

  function matchByDuration(list, dur) {
    let best = null, gap = Infinity;
    for (const rec of list || []) {
      const g = Math.abs((rec.duration_sec || 0) - dur);
      if (g <= DUR_TOL_SEC && g < gap) { best = rec; gap = g; }
    }
    return best;
  }

  /** Fetch fresh from the repo, falling back to whatever this install
   *  bundled locally -- so a git push updates every running copy without an
   *  extension update, but a stale/offline/permission-denied fetch still
   *  degrades to a working extension instead of a blank one. A plain fetch()
   *  has no built-in timeout: a captive portal or a dropped-not-refused
   *  connection hangs it far longer than a viewer waiting for the bar to
   *  draw should ever be stuck, so the remote attempt is capped and moves on
   *  to the local copy rather than trusting the network to fail fast. */
  async function fetchJsonRemoteFirst(remoteUrl, localPath, remoteTimeoutMs = 1500) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), remoteTimeoutMs);
      try {
        const r = await fetch(remoteUrl, { cache: "no-cache", signal: ctrl.signal });
        if (r.ok) return await r.json();
      } finally { clearTimeout(timer); }
    } catch (_) { /* offline, blocked, timed out, or the host permission was declined */ }
    try {
      const r = await fetch(chrome.runtime.getURL(localPath));
      if (r.ok) return await r.json();
    } catch (_) { /* fall through */ }
    return null;
  }

  /** The shared store is fetched fresh so contributions ingested since this
   *  extension was installed still arrive; the bundled copy is the offline
   *  fallback. Never fatal -- worst case the viewer just calibrates by hand. */
  async function fetchSharedCalibrations() {
    sharedCal = await fetchJsonRemoteFirst(SHARED_CAL_URL, "data/calibrations.json");
  }

  /** Apply a saved calibration: local first (it is this viewer's own reading
   *  of this exact recording), then the shared store. Anchors are the source
   *  of truth -- the transform is refitted from them so a restore behaves
   *  identically to having just typed the readings; the stored cal is only a
   *  fallback for records whose anchors can't refit. */
  /** Re-derive each reading's race time from the km that was actually typed.
   *
   *  An anchor stores two things: `km`, which the viewer read off the screen,
   *  and `tUtcMs`, the race time the profile said that km corresponded to.
   *  Only the first is input; the second is a DERIVED value, and it is only
   *  as good as the bundle that produced it. Stage 20's readings were taken
   *  against a bundle whose telemetry had been clobbered -- 53 observed
   *  points, positions inferred across most of the stage -- and it put km
   *  143.2 and 136.1 twenty-nine minutes apart where the repaired bundle puts
   *  them seventeen. Restoring those stale times reapplied that error, fitting
   *  a rate of 0.42 that clamped to the 0.5 floor and drew the whole race
   *  squeezed into half the bar.
   *
   *  So the km is what is trusted on the way back in, and the race time is
   *  recomputed against whatever bundle is loaded now. Every reading is kept
   *  -- none of this discards information -- except one whose km no longer
   *  falls in covered profile, which cannot be placed at all.
   *
   *  This also makes a shared calibration safe to adopt from someone whose
   *  bundle differed from yours: what travels is what they read off the
   *  screen, not their copy's idea of when that was. */
  function rehomeAnchors(list) {
    const out = [];
    let moved = 0, dropped = 0;
    for (const a of list) {
      const copy = { ...a };
      if (typeof a.km === "number" && bundle?.__kind !== "profile") {
        const exact = typeof a.kmto === "number"
          ? a.kmto : (Number.isInteger(a.km) ? a.km + 0.5 : a.km);
        const hit = timeAtKmToGo(exact);
        if (!hit) { dropped++; continue; }
        if (Math.abs(hit.tMs - (a.tUtcMs ?? hit.tMs)) > 1000) moved++;
        copy.tUtcMs = hit.tMs;
      }
      out.push(copy);
    }
    if (moved || dropped) {
      console.log(`[TourNavigator] re-homed ${moved} reading(s) onto this ` +
                  `bundle's timing` + (dropped ? `, dropped ${dropped} outside coverage` : ""));
    }
    return { list: out, moved, dropped };
  }

  function applyRecord(rec, from) {
    if (!rec) return false;
    // Flagged moments come back only from THIS browser. They are submitted to
    // the shared store so they can be studied in aggregate, but they are one
    // person's opinion of what was interesting -- restoring a stranger's onto
    // your bar would put marks there you never placed and cannot account for.
    // Readings are the opposite: they describe the recording itself, so
    // everyone watching it benefits from them.
    if (from === "this browser" && Array.isArray(rec.favourites)) {
      favourites = rec.favourites.filter((f) => f && isFinite(f.videoSec))
                                 .sort((a, b) => a.videoSec - b.videoSec);
    }
    if (!Array.isArray(rec.anchors) || !rec.anchors.length) return favourites.length > 0;
    const re = rehomeAnchors(rec.anchors);
    if (!re.list.length) return favourites.length > 0;
    anchors = re.list;
    // Take the contributor's breaks unless this player has already shown us
    // its own -- live markers beat remembered ones for the same recording.
    if (!adBreaks.length && Array.isArray(rec.ad_breaks)) {
      adBreaks = rec.ad_breaks.filter((n) => isFinite(n)).sort((a, b) => a - b);
    }
    if (bundle?.__kind === "profile") {
      // Lite: the anchors ARE the calibration (liteMap derives from them);
      // there is no clock transform to refit. Even a single saved reading is
      // restored -- it is half the setup the next viewer would otherwise redo.
      cal = null;
    } else {
      cal = calFromAnchors() || rec.cal || null;
      if (!cal) { anchors = []; return false; }
    }
    restoredFrom = from;
    flash(`calibration restored from ${from} ` +
          `(${pins().length} reading${pins().length === 1 ? "" : "s"}` +
          `${adBreaks.length ? `, ${adBreaks.length} ad breaks` : ""}` +
          `${re.moved ? `, ${re.moved} re-timed for this bundle` : ""}` +
          `${re.dropped ? `, ${re.dropped} outside coverage` : ""})` +
          " — reset if it looks off");
    render();
    return true;
  }

  function restoreCalibration() {
    if (!spanOf(video)) return;
    const dur = spanOf(video);
    const key = calStoreKey();
    const trySharedThenGiveUp = async () => {
      try { await sharedCalReady; } catch (_) {}
      const list = sharedCal?.recordings?.[`${stageKey()}|${SITE}`];
      const rec = matchByDuration(list, dur);
      if (rec) applyRecord(rec, "shared store");
    };
    try {
      chrome.storage.local.get([key], (r) => {
        const rec = matchByDuration(r?.[key]?.recordings, dur);
        if (!applyRecord(rec, "this browser")) trySharedThenGiveUp();
      });
    } catch (_) {
      trySharedThenGiveUp();
    }
  }

  /** Contribute this recording's calibration to the shared store, so the next
   *  person watching the same broadcast gets it for free.
   *
   *  Fired by the same button that adds a reading -- there is no separate
   *  share control. With a collector deployed this is silent: one POST, no
   *  account, no tab. Without one it falls back to the prefilled issue, whose
   *  tab is NAMED so a second reading reuses it rather than stacking tabs.
   *  Either way an identical payload is never sent twice, and failing to
   *  share never costs the viewer their calibration -- that is already saved
   *  locally by the time this runs. */
  let lastSharedPayload = "";
  async function shareCalibration() {
    const rec = calRecord();
    if (!rec.anchors.length) return;
    const payload = JSON.stringify(rec.anchors) + rec.duration_sec + rec.site;
    if (payload === lastSharedPayload) return;
    lastSharedPayload = payload;

    const note = (msg) => flash(msg, 5000);

    if (COLLECTOR_URL) {
      try {
        const r = await fetch(COLLECTOR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rec),
        });
        if (r.ok) { note("shared"); return; }
        // SAY which failure this is. Falling back to the issue form looks
        // identical whether no collector is configured, one is deployed but
        // erroring, or it is refusing this particular record -- and that
        // ambiguity hid a broken collector behind a working fallback for a
        // while. The reason it gives is worth surfacing verbatim: a 400 names
        // the field it objected to, and a 5xx means the collector itself is
        // unwell rather than the record being bad.
        let why = "";
        try { why = ((await r.json()) || {}).error || ""; } catch (_) {}
        note(`⚠ collector said ${r.status}${why ? `: ${why}` : ""} — ` +
             "opening the issue form instead", 20000);
      } catch (e) {
        note("⚠ collector unreachable — opening the issue form instead", 20000);
        console.warn("[TourNavigator] collector unreachable", e);
      }
      // Fall through: a rejected or unreachable collector shouldn't silently
      // swallow a contribution the viewer is willing to make by hand.
    }

    const title = `[calibration] stage ${rec.stage} · ${rec.site} · ` +
                  `${Math.round(rec.duration_sec)}s`;
    const body =
      "Automated calibration contribution from the Tour Navigator extension.\n" +
      "The ingest workflow merges the block below into extension/data/calibrations.json.\n\n" +
      "```json\n" + JSON.stringify(rec, null, 2) + "\n```\n";
    try {
      window.open(`${SHARE_ISSUE_URL}?title=${encodeURIComponent(title)}` +
                  `&body=${encodeURIComponent(body)}`, "tn-share");
    } catch (_) { /* popup blocked: the calibration is still saved locally */ }
  }

  // --------------------------------------------------------------- bootstrap

  /** How much of the recording is addressable, in seconds.
   *
   *  A recording reports it as `duration`. A LIVE stream reports Infinity and
   *  keeps the real answer in `seekable` -- the DVR window you can scrub back
   *  through. Reading only `duration` meant a live feed was rejected as "not
   *  a real video" and the panel never appeared on one at all. */
  function spanOf(v) {
    if (!v) return 0;
    if (isFinite(v.duration) && v.duration > 0) return v.duration;
    try {
      const s = v.seekable;
      if (s && s.length) return s.end(s.length - 1) - s.start(0);
    } catch (_) { /* not seekable yet */ }
    return 0;
  }

  const isLive = (v) => !!v && !isFinite(v.duration) && spanOf(v) > 0;

  /** Recording-second of the live edge, or null if this is not a live feed. */
  function liveEdge(v) {
    if (!isLive(v)) return null;
    try {
      const s = v.seekable;
      if (s && s.length) return s.end(s.length - 1);
    } catch (_) {}
    return null;
  }

  function findVideo() {
    const vids = [...document.querySelectorAll("video")]
      .filter((v) => spanOf(v) > 600);
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

  /** Stage numbers restart at 1 for every race (the Vuelta's stage 1 is not
   *  the Tour's), so anything that has to look a stage up by number rather
   *  than by its (unique) date -- the manual pin, the picker -- needs the
   *  race folded into the key or it can silently pick the wrong race's
   *  bundle. Index entries with no `race` are the Tour, the original data.
   *  Named distinctly from the existing zero-arg stageKey() elsewhere (that one
   *  keys calibration storage off whatever bundle is currently loaded; this
   *  one keys an arbitrary index entry, which is why it takes one). */
  function raceStageKey(s) {
    return (s.race || "tdf") + ":" + s.stage;
  }

  async function loadBundle() {
    const index = await fetchJsonRemoteFirst(REMOTE_DATA_BASE + "index.json", "data/index.json");
    if (!index || !index.stages || !index.stages.length) {
      throw new Error("no stage bundles shipped");
    }

    // A manual choice always wins and is remembered per browser. Pre-Vuelta
    // versions of this extension stored a bare stage number here; since the
    // Tour was the only race that existed then, a number found in storage
    // now means exactly what raceStageKey() would have produced for it.
    const pinned = await new Promise((res) => {
      try {
        chrome.storage.local.get(["tnPinnedStage"], (r) => {
          const p = r?.tnPinnedStage ?? null;
          res(typeof p === "number" ? raceStageKey({ race: "tdf", stage: p }) : p);
        });
      } catch (_) { res(null); }
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
        if (pinned && pinned !== raceStageKey(detected)) {
          why += ` (ignoring stale pin to stage ${pinned})`;
          try { chrome.storage.local.remove("tnPinnedStage"); } catch (_) {}
        }
      } else if (pinned && index.stages.find((s) => raceStageKey(s) === pinned)) {
        chosen = index.stages.find((s) => raceStageKey(s) === pinned);
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
                "| available:", index.stages.map((s) => `${raceStageKey(s)}@${s.date}`));
    bundle_index = index;
    bundle_selection_ok = /^matched/.test(why);   // a pin means detection failed
    const b = await fetchJsonRemoteFirst(REMOTE_DATA_BASE + chosen.file, "data/" + chosen.file);
    if (!b) throw new Error(`stage bundle "${chosen.file}" fetched nowhere -- offline and not bundled`);
    b.__selection = why;
    b.__kind = chosen.kind || "full";
    b.__airingMs = airing;
    if (b.stage) b.stage.race = chosen.race || "tdf";
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
    // Lite stages (no live capture -- see renderLite): the event filters hide
    // (there are no events), but calibration stays -- readings pin the profile
    // straight onto the recording timeline instead of onto a race clock.
    if (bundle.__kind === "profile") {
      root.classList.add("tn-lite");
      root.querySelector(".tn-setup-ask").innerHTML =
        `Pause where the broadcast shows <strong>km to go</strong> and type it
         (two readings, far apart, place this profile on your recording):`;
    }
    const s = bundle.stage || {};
    root.querySelector(".tn-stage").textContent =
      `Stage ${s.stage ?? "?"} · ${s.departure ?? ""} → ${s.arrival ?? ""} · ${s.length_km ?? "?"}km`;
    root.querySelector(".tn-stage").title = bundle.__selection || "";
    populateStagePicker();
    if (!bundle_selection_ok) {
      root.classList.add("tn-warn");
      root.querySelector(".tn-stage").textContent += "  ⚠ " + (bundle.__selection || "");
    }
    // Wipe only the LEGACY per-stage slot (pre-rework, could be any
    // recording's numbers). Properly-keyed calibrations are restored the
    // moment the player exposes a duration -- silently, bar up straight away,
    // with a note saying where the numbers came from and reset one click away.
    clearLegacyStored();
    anchors = [];
    // Start from the broadcast's own shape rather than from nothing: an hour
    // of build-up then 0.92x. That is already close enough to draw and to
    // navigate roughly by, so the bar appears immediately and a reading
    // becomes a refinement rather than a precondition. (It used to sit behind
    // a setup gate on the grounds that an uncalibrated profile invites false
    // readings -- but a stated, visible default is not the same thing as no
    // clock at all, and the diag says which model is in use.)
    cal = defaultCal();
    render();
    sharedCalReady = fetchSharedCalibrations();

    setInterval(() => {
      const v = findVideo();
      if (v && v !== video) video = v;
      if (spanOf(video) && !anchoredToVideo) {
        // start() runs before any <video> exists, so the model built there
        // could not know whether this is a live feed. Rebuild it once, now
        // that there is something to ask -- but only while no reading has
        // been given, since a reading outranks any assumption.
        anchoredToVideo = true;
        if (!pins().length) {
          const d = defaultCal();
          if (d) { cal = d; render(); }
        }
      }
      if (spanOf(video) && !triedRestore) {
        triedRestore = true;
        restoreCalibration();
      }
      // Markers only exist in the DOM while the player's own bar is up, and
      // it comes and goes with the mouse -- so this keeps looking rather than
      // checking once at load and concluding there are none.
      sampleWatching();
      refreshAdBreaks();
      render();          // unconditional: the profile draws with or without video
    }, 500);
    window.addEventListener("resize", render);

    // Send periodically so a crashed tab still yields most of the session, and
    // once more when the page goes away.
    setInterval(() => sendSession(false), 120000);
    window.addEventListener("pagehide", () => sendSession(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") sendSession(true);
    });

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

  /** The seek bar element itself, not just its top edge -- ad markers are
   *  drawn inside it, so the local model needs the box, not the y. */
  function nativeSeekBarEl() {
    const SEL = [
      '[role="slider"]', 'input[type="range"]',
      '[aria-label*="seek" i]', '[aria-label*="scrubber" i]',
      '[aria-label*="progress bar" i]',
      '[class*="scrubber" i]', '[class*="seekbar" i]', '[class*="seek-bar" i]',
      '[class*="progress-bar" i]', '[class*="progressBar"]',
      '[data-testid*="scrubber" i]', '[data-testid*="seek" i]',
    ].join(",");
    let best = null, bestTop = Infinity;
    let els;
    try { els = document.querySelectorAll(SEL); } catch (_) { return null; }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.4) continue;
      if (r.top < window.innerHeight * 0.55) continue;
      if (!r.width || !r.height) continue;
      if (r.top < bestTop) { best = el; bestTop = r.top; }
    }
    return best;
  }

  /* Ad markers as the player itself draws them.
   *
   * Peacock ticks its own scrub bar where the breaks are, which makes the bar
   * the one place those boundaries are stated rather than guessed. Each tick
   * is a small element positioned along the bar's width, so its centre as a
   * fraction of the bar IS its position in the recording.
   *
   * Written defensively, because their markup is not an API and this cannot
   * be verified without a real session: anything that fails a sanity check is
   * dropped, and finding nothing simply leaves adBreaks empty, which the
   * clock already treats as "global model only". A wrong marker would place a
   * false interval boundary and drift silently, so the bar is set high --
   * better no local layer than an invented one. */
  function detectAdBreaks() {
    // A feed with no commercial breaks has no markers to find, and scanning
    // for them would only invite a false positive off some other tick.
    if (!SITE_PROFILE.ads) return [];
    const bar = nativeSeekBarEl();
    const dur = spanOf(video);
    if (!bar || !dur) return [];
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return [];
    return breakCandidates(bar, rect, dur).positions;
  }

  /* Candidate ad markers, found by SHAPE rather than by class name.
   *
   * The first version matched on names -- "ad-marker", "cue", "chapter" --
   * and found nothing on the real player, which is the trouble with guessing
   * at markup that is not an API. What a break marker actually IS, on every
   * player that draws one, is a narrow tick sitting inside the seek bar at
   * the position of the break. That is checkable without knowing what anyone
   * chose to call it:
   *
   *   - narrow: a few pixels, never a meaningful share of the bar's width
   *     (a wide element is the track, the buffered range or the played fill)
   *   - tall: a decent share of the bar's height, so it reads as a tick
   *   - inside: horizontally within the bar, and not pinned to either end
   *
   * The scrubber thumb fits that description too, so anything sitting at the
   * current playback position is discarded -- it moves, and a break does not.
   *
   * Returns the diagnostic alongside the answer so __tnAdDebug can show what
   * was considered and why each candidate was kept or dropped. */
  function breakCandidates(bar, rect, dur) {
    const considered = [];
    // Look at the bar's SURROUNDINGS, not just its children. Players commonly
    // draw markers in a sibling overlay laid across the track rather than
    // inside it, and searching only descendants missed those entirely --
    // which is why a recording with several breaks reported one. Anything in
    // the neighbourhood that overlaps the bar's own band is a candidate; the
    // shape tests below still decide.
    let els;
    try {
      const scope = bar.parentElement?.parentElement || bar.parentElement || bar;
      els = scope.querySelectorAll("*");
    } catch (_) { return { positions: [], considered }; }

    const playFrac = video && dur ? video.currentTime / dur : -1;
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // Must sit on the bar's own horizontal band, or it is some other part
      // of the control cluster rather than something drawn on the track.
      const midY = r.top + r.height / 2;
      if (midY < rect.top - rect.height || midY > rect.bottom + rect.height) continue;
      const frac = ((r.left + r.width / 2) - rect.left) / rect.width;
      const rec = {
        cls: (el.className && el.className.baseVal !== undefined
                ? el.className.baseVal : String(el.className || "")).slice(0, 60),
        tag: el.tagName.toLowerCase(),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        frac: +frac.toFixed(4), why: "",
      };
      if (r.width > Math.max(12, rect.width * 0.02)) rec.why = "too wide (track/fill)";
      else if (r.height < Math.min(4, rect.height * 0.25)) rec.why = "too short to be a tick";
      else if (!(frac > 0.005 && frac < 0.995)) rec.why = "at an end";
      else if (playFrac >= 0 && Math.abs(frac - playFrac) < 0.01) rec.why = "at the playhead (thumb)";
      else {
        rec.why = "KEPT";
        out.push({ sec: Math.round(frac * dur), w: rec.w, h: rec.h });
      }
      considered.push(rec);
    }

    /* Which of the survivors are actually the markers?
     *
     * Widening the search stopped it missing them and started it catching
     * furniture instead -- 27 on a broadcast that has nearer a dozen. Rather
     * than tighten the shape tests by eye again, use the property that makes
     * markers markers: a player draws them all THE SAME. Ticks for one kind
     * of thing share a width, a height and a styling; the odd bits of control
     * furniture that survive the shape tests do not match each other.
     *
     * So group the survivors by their exact rendered size, and take the
     * largest group that is a plausible number of breaks. A single stray
     * element cannot form a group, and a set of identical ticks will.
     */
    const groups = new Map();
    for (const c of out) {
      const key = `${c.w}x${c.h}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c.sec);
    }
    const dedupe = (arr) => [...new Set(arr)].sort((a, b) => a - b)
      .filter((s, i, a2) => i === 0 || s - a2[i - 1] > 30);

    let best = [], bestKey = null;
    for (const [key, secs] of groups) {
      const d = dedupe(secs);
      // Two is the fewest that can show a pattern. The upper bound is
      // deliberately loose: an earlier version capped at 20 on the assumption
      // that a stage carries 8-12 breaks, which threw away the real set on a
      // broadcast that has nearer 30 and left a stray pair to win instead.
      // A five-hour broadcast can carry a lot of breaks, so only a count that
      // could not be breaks at all is rejected here.
      if (d.length < 2 || d.length > MAX_PLAUSIBLE_BREAKS) continue;
      if (d.length > best.length) { best = d; bestKey = key; }
    }
    for (const c of considered) {
      if (c.why === "KEPT" && bestKey && `${c.w}x${c.h}` !== bestKey) {
        c.why = `dropped: not the ${bestKey} group`;
      }
    }
    return { positions: best, considered, groups: [...groups].map(([k, v]) =>
      ({ size: k, count: dedupe(v).length, chosen: k === bestKey })) };
  }

  /* Paste-able diagnostic, for when detection finds nothing on a player whose
   * markup we cannot see from here. Run __tnAdDebug() in the console with the
   * controls showing. */
  window.__tnAdDebug = function () {
    const bar = nativeSeekBarEl();
    if (!bar) {
      console.log("[TourNavigator] no seek bar found. Is the player's control " +
                  "bar visible? Move the mouse over the video, then re-run.");
      const wide = [...document.querySelectorAll("*")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth * 0.4 && r.height > 0 && r.height < 40 &&
               r.top > window.innerHeight * 0.5;
      }).slice(0, 25).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 70),
        testid: el.getAttribute("data-testid"),
        aria: el.getAttribute("aria-label"),
        role: el.getAttribute("role"),
        top: Math.round(el.getBoundingClientRect().top),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
      }));
      console.log("wide low elements that COULD be the bar:", wide);
      return wide;
    }
    const rect = bar.getBoundingClientRect();
    const { positions, considered, groups } = breakCandidates(bar, rect, spanOf(video));
    console.log("[TourNavigator] seek bar:", {
      tag: bar.tagName.toLowerCase(),
      cls: String(bar.className || "").slice(0, 80),
      testid: bar.getAttribute("data-testid"),
      w: Math.round(rect.width), h: Math.round(rect.height),
      descendants: bar.querySelectorAll("*").length,
    });
    console.log("[TourNavigator] kept:", positions.map(fmt));
    console.log("[TourNavigator] identical-size groups found:", groups);
    console.table(considered.slice(0, 60));
    const report = {
      bar: {
        tag: bar.tagName.toLowerCase(), cls: String(bar.className || "").slice(0, 80),
        testid: bar.getAttribute("data-testid"),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
      duration: Math.round(spanOf(video)),
      kept: positions,
      groups,
      considered: considered.slice(0, 120),
    };
    const blob = JSON.stringify(report);
    try {
      navigator.clipboard.writeText(blob);
      console.log("[TourNavigator] the whole report is now on your clipboard — " +
                  "just paste it. (" + blob.length + " chars)");
    } catch (_) {
      console.log("[TourNavigator] copy the line below and paste it back:");
      console.log(blob);
    }
    return report;
  };

  /* Scanning is not destructive.
   *
   * The markers only exist in the DOM while the player's own control bar is
   * up, and it comes and goes with the mouse. The scan therefore returns
   * nothing most of the time -- not because the recording has no breaks, but
   * because there is nothing on screen to read. Treating that as an answer
   * wiped a good set of breaks the moment the controls faded, so the panel
   * flipped back to "no ad breaks found" seconds after finding them, and the
   * local calibration layer went with it.
   *
   * So an empty scan is ignored, and a smaller one is not allowed to replace
   * a larger one for the same recording: markers fade in progressively, and a
   * half-rendered bar should not overwrite a complete reading. Anything found
   * is kept until the recording itself changes. */
  let adBreakSource = "";        // which recording the current set belongs to

  function refreshAdBreaks() {
    const key = video ? String(Math.round(spanOf(video))) : "";
    if (key !== adBreakSource) {
      // A different recording, so anything held belongs to the old one --
      // EXCEPT breaks a restore just supplied for this one, which arrive
      // asynchronously and could otherwise be wiped by whichever tick happens
      // to notice the duration first. Claiming the key without clearing is
      // right when the two already agree about the recording.
      adBreakSource = key;
      if (!restoredFrom) adBreaks = [];
    }
    const found = detectAdBreaks();
    if (!found.length) return;            // nothing on screen to read, not an answer
    if (found.length < adBreaks.length) return;   // partial render; keep the fuller set
    const changed = found.length !== adBreaks.length ||
                    found.some((s, i) => s !== adBreaks[i]);
    if (changed) {
      adBreaks = found;
      console.log("[TourNavigator] ad breaks detected:", adBreaks.length,
                  adBreaks.map((s) => fmt(s)).join(", "));
      render();
    }
  }

  function installChrome() {
    const GAP = 12;                 // px to float above the native bar
    const HIDE_AFTER_MS = 3000;
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
