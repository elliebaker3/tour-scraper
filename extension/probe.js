/* Tour Navigator — capability probe.
 *
 * Captions turned out not to be exposed, which is normal for a DRM player. The
 * useful next step is not to guess at another signal but to find out what this
 * page genuinely offers. This enumerates the places a broadcast's wall-clock
 * start time tends to hide, and reports what it finds.
 *
 * Everything here is read-only metadata: element properties, timing ranges and
 * app-state objects the page already put on `window`. No frames are read, no
 * stream content is touched.
 *
 * The single most valuable find would be the broadcast's start timestamp. With
 * it, offset comes for free and only rate (ad breaks) is left to estimate.
 */

(() => {
  "use strict";

  // Timestamps anywhere near the Tour, in the formats app state tends to use.
  const ISO_RE = /"?(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"?/g;
  const EPOCH_RE = /\b(1[6-9]\d{11}|1[6-9]\d{8})\b/g;      // ms or s since epoch

  const GLOBAL_KEYS = [
    "__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__",
    "__NUXT__", "__REDUX_STATE__", "dataLayer", "digitalData", "utag_data",
    "playerInstance", "player", "videoPlayer", "shaka", "hls", "bitmovin",
  ];

  const TIME_KEY_RE =
    /(start|begin|air|broadcast|scheduled|event|programme?|epg|live|onair|utc|date|time)/i;

  function ranges(tr) {
    const out = [];
    try {
      for (let i = 0; i < tr.length; i++) {
        out.push([+tr.start(i).toFixed(1), +tr.end(i).toFixed(1)]);
      }
    } catch (_) { /* ranges can throw while the player is re-buffering */ }
    return out;
  }

  /** Read cues from every timed track, whatever its kind, and sample them.
   *  Metadata cues may be DataCue (.value/.data) rather than VTTCue (.text),
   *  and .value can be a structured object, so all shapes are flattened. */
  function sampleTimedTracks(video) {
    const out = [];
    for (const track of video.textTracks || []) {
      const prior = track.mode;
      // Cues are only populated once a track is at least "hidden".
      try { if (track.mode === "disabled") track.mode = "hidden"; } catch (_) {}
      const cues = track.cues ? [...track.cues] : [];
      const describe = (cue) => {
        let body = "";
        try {
          if (typeof cue.text === "string" && cue.text) body = cue.text;
          else if (cue.value !== undefined) body = JSON.stringify(cue.value);
          else if (cue.data) body = "[binary " + (cue.data.byteLength || "?") + "B]";
        } catch (e) { body = "[unreadable]"; }
        return { t: +cue.startTime.toFixed(2), end: +(cue.endTime || 0).toFixed(2),
                 body: String(body).replace(/\s+/g, " ").slice(0, 220) };
      };
      // First few, last few, plus anything containing a timestamp or ad marker.
      const head = cues.slice(0, 6).map(describe);
      const tail = cues.slice(-4).map(describe);
      const interesting = [];
      for (const c of cues) {
        const d = describe(c);
        if (/20\d{2}-\d{2}-\d{2}|\b1[6-9]\d{11}\b|\b1[6-9]\d{8}\b|ad(break|_break|start|end)|cue(in|out)|slate|SCTE/i.test(d.body)) {
          interesting.push(d);
          if (interesting.length >= 14) break;
        }
      }
      // The cue BODIES are empty on this track, but the cue TIMES are exactly
      // what we're after: ad breaks show up as their own cues. So dump every
      // cue's [start, end] compactly, plus whatever weak type signal each
      // carries (id / constructor / the keys of a structured .value), so the
      // break cues can be told apart from content markers.
      const allCues = cues.map((c) => {
        const o = { t: +c.startTime.toFixed(2), e: +(c.endTime || 0).toFixed(2) };
        try {
          if (c.id) o.id = String(c.id).slice(0, 40);
          const cls = c.constructor && c.constructor.name;
          if (cls && cls !== "VTTCue") o.cls = cls;
          if (c.value && typeof c.value === "object") o.vk = Object.keys(c.value).slice(0, 8);
          else if (c.value !== undefined && c.value !== null) o.v = String(c.value).slice(0, 60);
          if (c.type) o.ct = String(c.type).slice(0, 24);
        } catch (_) { /* best effort */ }
        return o;
      });

      out.push({
        kind: track.kind, label: track.label, cueCount: cues.length,
        head, tail, interesting, allCues,
      });
      try { if (prior === "disabled") track.mode = prior; } catch (_) {}
    }
    return out;
  }

  function probeVideo() {
    const vids = [...document.querySelectorAll("video")];
    return vids.map((v) => {
      const info = {
        duration: v.duration,
        currentTime: v.currentTime,
        // getStartDate() exposes an HLS stream's wall-clock origin. Not in
        // every engine, but when present it is exactly the offset we want.
        getStartDate: null,
        currentSrc: (v.currentSrc || "").slice(0, 120),
        srcIsBlob: (v.currentSrc || "").startsWith("blob:"),
        buffered: ranges(v.buffered),
        seekable: ranges(v.seekable),
        textTracks: [...(v.textTracks || [])].map((t) => ({
          kind: t.kind, label: t.label, mode: t.mode, cues: t.cues ? t.cues.length : null,
        })),
        // Metadata tracks (e.g. an analytics SDK's event track) are where ad
        // markers and timed timestamps hide once captions are withheld.
        timedSamples: sampleTimedTracks(v),
        datasetKeys: Object.keys(v.dataset || {}),
      };
      try {
        if (typeof v.getStartDate === "function") {
          const d = v.getStartDate();
          info.getStartDate = (d && !isNaN(d.getTime())) ? d.toISOString() : "invalid";
        }
      } catch (_) { info.getStartDate = "threw"; }
      return info;
    });
  }

  /** Walk an object graph shallowly, collecting time-looking values. */
  function harvestObject(obj, rootName, maxNodes = 4000) {
    const hits = [];
    const seen = new WeakSet();
    let nodes = 0;
    const walk = (o, path) => {
      if (!o || typeof o !== "object" || nodes++ > maxNodes || seen.has(o)) return;
      seen.add(o);
      for (const k of Object.keys(o)) {
        let v;
        try { v = o[k]; } catch (_) { continue; }
        if (v && typeof v === "object") {
          walk(v, path + "." + k);
        } else if ((typeof v === "string" || typeof v === "number") && TIME_KEY_RE.test(k)) {
          const s = String(v);
          if (/^20\d{2}-\d{2}-\d{2}/.test(s) || /^1[6-9]\d{8,11}$/.test(s)) {
            hits.push({ path: (path + "." + k).slice(0, 90), value: s.slice(0, 40) });
          }
        }
      }
    };
    walk(obj, rootName);
    return hits;
  }

  function probeGlobals() {
    const found = {};
    for (const key of GLOBAL_KEYS) {
      let v;
      try { v = window[key]; } catch (_) { continue; }
      if (!v) continue;
      found[key] = typeof v === "object" ? harvestObject(v, key).slice(0, 25)
                                         : String(v).slice(0, 80);
    }
    // Any other window key that smells like app state.
    const extra = [];
    for (const k of Object.keys(window)) {
      if (/^__|state|player|config|app/i.test(k) && !GLOBAL_KEYS.includes(k)) {
        let v; try { v = window[k]; } catch (_) { continue; }
        if (v && typeof v === "object") extra.push(k);
      }
    }
    return { found, otherStateLikeKeys: extra.slice(0, 40) };
  }

  /** Inline JSON blobs (script tags) are where SSR frameworks stash metadata. */
  function probeScripts() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/json"], script[id], script[data-state]')) {
      const txt = s.textContent || "";
      if (txt.length < 40 || txt.length > 4_000_000) continue;
      const isos = [...txt.matchAll(ISO_RE)].map((m) => m[1]).slice(0, 12);
      const epochs = [...txt.matchAll(EPOCH_RE)].map((m) => m[1]).slice(0, 8);
      if (isos.length || epochs.length) {
        out.push({
          id: s.id || s.getAttribute("type") || "script",
          bytes: txt.length,
          isoSamples: [...new Set(isos)].slice(0, 8),
          epochSamples: [...new Set(epochs)].slice(0, 6),
        });
      }
    }
    return out.slice(0, 12);
  }

  /** data-* attributes and aria labels sometimes carry the airing time. */
  function probeDom() {
    const hits = [];
    const all = document.querySelectorAll("*[data-testid], *[data-track], *[aria-label], time");
    let n = 0;
    for (const el of all) {
      if (n++ > 2500) break;
      for (const attr of el.getAttributeNames()) {
        if (!TIME_KEY_RE.test(attr) && attr !== "datetime") continue;
        const v = el.getAttribute(attr) || "";
        if (/^20\d{2}-\d{2}-\d{2}/.test(v) || /^1[6-9]\d{8,11}$/.test(v)) {
          hits.push({ tag: el.tagName.toLowerCase(), attr, value: v.slice(0, 40) });
        }
      }
    }
    return hits.slice(0, 25);
  }

  /** Ask the MAIN-world half for page globals and merge its answer in. */
  function requestMainWorld(timeoutMs = 900) {
    return new Promise((resolve) => {
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__tn !== "probe-response") return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(ev.data.payload);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __tn: "probe-request" }, "*");
      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", onMsg);
          resolve({ unavailable: "MAIN-world probe did not respond" });
        }
      }, timeoutMs);
    });
  }

  function runProbe() {
    const report = {
      url: location.href.split("?")[0],
      when: new Date().toISOString(),
      video: probeVideo(),
      globals: probeGlobals(),
      scripts: probeScripts(),
      dom: probeDom(),
    };
    // Rank the most promising candidates for a broadcast start time.
    const candidates = [];
    for (const v of report.video) {
      if (v.getStartDate && v.getStartDate !== "invalid" && v.getStartDate !== "threw") {
        candidates.push({ source: "video.getStartDate()", value: v.getStartDate, rank: 1 });
      }
    }
    for (const [k, hits] of Object.entries(report.globals.found)) {
      if (Array.isArray(hits)) {
        for (const h of hits) candidates.push({ source: `window.${k}.${h.path}`, value: h.value, rank: 2 });
      }
    }
    for (const d of report.dom) {
      candidates.push({ source: `dom[${d.tag}@${d.attr}]`, value: d.value, rank: 3 });
    }
    report.startTimeCandidates = candidates.sort((a, b) => a.rank - b.rank).slice(0, 20);
    return report;
  }

  /** Async variant: same report plus whatever the MAIN world could see. */
  async function runProbeFull() {
    const report = runProbe();
    report.mainWorld = await requestMainWorld();
    for (const h of (report.mainWorld && report.mainWorld.globalHits) || []) {
      report.startTimeCandidates.push({ source: "page." + h.path, value: h.value, rank: 2 });
    }
    report.startTimeCandidates = report.startTimeCandidates
      .sort((a, b) => a.rank - b.rank).slice(0, 30);
    window.TourNavigatorProbe.lastFullReport = report;
    return report;
  }

  window.TourNavigatorProbe = { runProbe, runProbeFull };
})();
