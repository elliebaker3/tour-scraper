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

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__tn !== "probe-request") return;
    let payload;
    try { payload = run(); }
    catch (e) { payload = { globalHits: [], scannedKeys: [], errors: [String(e)] }; }
    window.postMessage({ __tn: "probe-response", payload }, "*");
  });
})();
