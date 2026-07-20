/* Tour Navigator — MAIN-world probe.
 *
 * Content scripts run in an isolated world: they share the DOM but NOT the
 * page's JavaScript globals. So the first probe reporting "no globals found"
 * on Peacock was measuring my own blind spot, not the page. This half runs in
 * the page's own world (manifest `"world": "MAIN"`), where app state such as
 * __NEXT_DATA__ or a player instance is actually reachable, and posts what it
 * finds back over window.postMessage.
 *
 * Read-only: it enumerates existing objects for timestamp-shaped values. It
 * does not call player methods, touch frames or read stream content.
 */

(() => {
  "use strict";

  const TIME_KEY_RE =
    /(start|begin|air|broadcast|scheduled|event|programme?|epg|live|onair|utc|date|time|pdt)/i;
  const looksTemporal = (s) =>
    /^20\d{2}-\d{2}-\d{2}/.test(s) || /^1[6-9]\d{8}$/.test(s) || /^1[6-9]\d{11}$/.test(s);

  function harvest(obj, rootName, maxNodes = 20000) {
    const hits = [];
    const seen = new WeakSet();
    let nodes = 0;
    const walk = (o, path, depth) => {
      if (!o || typeof o !== "object" || depth > 12 || nodes++ > maxNodes) return;
      if (seen.has(o)) return;
      seen.add(o);
      let keys;
      try { keys = Object.keys(o); } catch (_) { return; }
      for (const k of keys) {
        let v;
        try { v = o[k]; } catch (_) { continue; }
        if (v && typeof v === "object") {
          walk(v, path + "." + k, depth + 1);
        } else if (typeof v === "string" || typeof v === "number") {
          const s = String(v);
          if (looksTemporal(s) && (TIME_KEY_RE.test(k) || TIME_KEY_RE.test(path))) {
            hits.push({ path: (path + "." + k).slice(0, 120), value: s.slice(0, 40) });
          }
        }
        if (hits.length > 400) return;
      }
    };
    walk(obj, rootName, 0);
    return hits;
  }

  function run() {
    const report = { globalHits: [], scannedKeys: [], errors: [] };
    let keys = [];
    try { keys = Object.keys(window); } catch (e) { report.errors.push(String(e)); }

    // Skip the obviously inert globals so the walk stays cheap.
    const SKIP = /^(window|self|top|parent|frames|document|location|navigator|console|chrome|webkit)/i;
    for (const k of keys) {
      if (SKIP.test(k)) continue;
      let v;
      try { v = window[k]; } catch (_) { continue; }
      if (!v || typeof v !== "object") continue;
      report.scannedKeys.push(k);
      try {
        const hits = harvest(v, k);
        if (hits.length) report.globalHits.push(...hits.slice(0, 40));
      } catch (e) { report.errors.push(k + ": " + String(e).slice(0, 60)); }
      if (report.globalHits.length > 300) break;
    }
    report.scannedKeys = report.scannedKeys.slice(0, 120);
    return report;
  }

  /* Peacock's playback state carries the asset's airing times, and shaka is
   * present as a global. Both are far better clocks than anything guessed at,
   * so surface them explicitly rather than leaving them buried in the generic
   * timestamp sweep. All read-only: no player methods that change state. */
  function playbackState() {
    const out = {};
    try {
      const ps = window.__PLAYBACK_STATE__;
      const attrs = ps && ps.assetData && ps.assetData.attributes;
      if (attrs) {
        out.displayStartTime = attrs.displayStartTime ?? null;
        out.eventPlayableStartDate = attrs.eventDetails?.eventPlayableStartDate ?? null;
        out.eventDisplayStartDate = attrs.eventDetails?.eventDisplayStartDate ?? null;
        out.eventDisplayEndDate = attrs.eventDetails?.eventDisplayEndDate ?? null;
        out.title = String(attrs.title || attrs.name || "").slice(0, 120);
      }
      if (ps && ps.assetMetadata) {
        out.assetMetadataDisplayStartTime = ps.assetMetadata.displayStartTime ?? null;
      }
    } catch (e) { out.error = String(e).slice(0, 80); }
    return out;
  }

  /** A shaka Player instance can report the stream's wall clock directly,
   *  which beats inferring offset from scheduling metadata. Find one by duck
   *  typing rather than assuming where the app stored it. */
  function shakaClock() {
    const isPlayer = (o) => o && typeof o === "object" &&
      typeof o.getPresentationStartTimeAsDate === "function";
    const found = [];
    const seen = new WeakSet();
    const visit = (o, path, depth) => {
      if (found.length || !o || typeof o !== "object" || depth > 4 || seen.has(o)) return;
      seen.add(o);
      if (isPlayer(o)) { found.push({ o, path }); return; }
      let keys; try { keys = Object.keys(o); } catch (_) { return; }
      for (const k of keys.slice(0, 200)) {
        let v; try { v = o[k]; } catch (_) { continue; }
        if (v && typeof v === "object") visit(v, path + "." + k, depth + 1);
        if (found.length) return;
      }
    };
    let roots = [];
    try { roots = Object.keys(window).filter((k) => /shaka|player|cvsdk|CVSDK|video/i.test(k)); }
    catch (_) {}
    for (const k of roots) {
      let v; try { v = window[k]; } catch (_) { continue; }
      if (v && typeof v === "object") visit(v, k, 0);
      if (found.length) break;
    }
    if (!found.length) return { available: false };
    const { o, path } = found[0];
    const res = { available: true, path };
    try {
      const d = o.getPresentationStartTimeAsDate();
      res.presentationStart = d && !isNaN(d.getTime()) ? d.toISOString() : null;
    } catch (e) { res.presentationStartError = String(e).slice(0, 60); }
    try {
      const d = o.getPlayheadTimeAsDate && o.getPlayheadTimeAsDate();
      res.playheadTime = d && !isNaN(d.getTime()) ? d.toISOString() : null;
    } catch (e) { res.playheadError = String(e).slice(0, 60); }
    return res;
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__tn !== "probe-request") return;
    let payload;
    try {
      payload = run();
      payload.playbackState = playbackState();
      payload.shakaClock = shakaClock();
    }
    catch (e) { payload = { globalHits: [], scannedKeys: [], errors: [String(e)] }; }
    window.postMessage({ __tn: "probe-response", payload }, "*");
  });
})();
