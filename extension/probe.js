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

  window.TourNavigatorProbe = { runProbe };
})();
