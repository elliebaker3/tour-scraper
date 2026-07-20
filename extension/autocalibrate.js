/* Tour Navigator — automatic timeline calibration.
 *
 * Goal: work out offset AND rate between race time and recording time without
 * the viewer hand-placing anchors.
 *
 * The trick is that cycling commentary is full of "N kilometres to go", and our
 * GPS data knows precisely when the leader was at any given km-to-go. So every
 * such phrase in the caption track is a candidate (recording second -> race
 * time) pair. One is noise; forty of them, robustly fitted, is a calibration.
 *
 * What this reads: `video.textTracks`, a standard DOM API on a page the viewer
 * is already authenticated to. Cue text is scanned in memory for a number and
 * immediately discarded — nothing from the broadcast is stored, copied or
 * emitted. The only output is two numbers: offset and rate.
 *
 * Robustness matters because the signal is genuinely noisy: a commentator may
 * round ("about forty k"), refer to a chase group rather than the leader, or
 * repeat a stale number. So we fit with Theil–Sen (median of pairwise slopes)
 * rather than least squares — it tolerates a large fraction of bad pairs
 * instead of letting one wild outlier drag the line.
 */

(() => {
  "use strict";

  // "42km to go", "42 kilometres remaining", "42.5 k to go", "under 10km left"
  const KM_RE =
    /(\d{1,3}(?:[.,]\d)?)\s*(?:k|km|kilometers?|kilometres?)\b[^.!?]{0,24}?\b(?:to go|to race|remaining|left|from (?:the )?(?:finish|line))/i;
  // "inside the final 5 kilometres"
  const FINAL_RE =
    /(?:final|last)\s+(\d{1,3}(?:[.,]\d)?)\s*(?:k|km|kilometers?|kilometres?)\b/i;

  /** Sorted [kmToGo -> race-time ms] index built from the synced profile. */
  function buildKmIndex(bundle) {
    const total = Number(bundle?.stage?.length_km) || 0;
    if (!total) return [];
    const idx = [];
    for (const p of bundle.profile || []) {
      if (!p.t || p.interp) continue;          // observed points only
      idx.push({ kmToGo: total - p.km, tMs: Date.parse(p.t) });
    }
    idx.sort((a, b) => a.kmToGo - b.kmToGo);
    return idx;
  }

  /** Interpolate the race time at which the leader had `km` left to race. */
  function kmToGoToUtc(idx, km) {
    if (!idx.length) return null;
    if (km < idx[0].kmToGo || km > idx[idx.length - 1].kmToGo) return null;
    let lo = 0, hi = idx.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (idx[mid].kmToGo <= km) lo = mid; else hi = mid;
    }
    const a = idx[lo], b = idx[hi];
    const span = b.kmToGo - a.kmToGo;
    if (span <= 0) return a.tMs;
    const f = (km - a.kmToGo) / span;
    return a.tMs + (b.tMs - a.tMs) * f;
  }

  /** Cues from every text track, without rendering them on screen. */
  function collectCues(video) {
    const out = [];
    const tracks = video.textTracks || [];
    for (const track of tracks) {
      if (!/subtitle|caption/i.test(track.kind || "")) continue;
      // "hidden" parses cues without displaying them, so enabling calibration
      // never switches subtitles on for the viewer.
      const prior = track.mode;
      if (track.mode === "disabled") track.mode = "hidden";
      const cues = track.cues;
      if (cues) {
        for (const cue of cues) {
          const text = (cue.text || "").replace(/<[^>]+>/g, " ");
          if (text) out.push({ sec: cue.startTime, text });
        }
      }
      if (prior === "disabled" && !out.length) track.mode = prior;
    }
    return out;
  }

  /** Turn cues into (recording second, race time ms) candidate pairs. */
  function candidatePairs(cues, idx) {
    const pairs = [];
    for (const { sec, text } of cues) {
      const m = KM_RE.exec(text) || FINAL_RE.exec(text);
      if (!m) continue;
      const km = parseFloat(m[1].replace(",", "."));
      if (!isFinite(km) || km <= 0 || km > 400) continue;
      const tMs = kmToGoToUtc(idx, km);
      if (tMs == null) continue;
      pairs.push({ sec, tMs, km });
    }
    // Cue text is not retained beyond this point.
    return pairs;
  }

  /** Theil–Sen fit of sec = offset + rate * (tMs/1000). Outlier tolerant. */
  function theilSen(pairs) {
    const n = pairs.length;
    if (n < 3) return null;
    const slopes = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dt = (pairs[j].tMs - pairs[i].tMs) / 1000;
        if (Math.abs(dt) < 60) continue;      // too close to slope reliably
        slopes.push((pairs[j].sec - pairs[i].sec) / dt);
      }
    }
    if (!slopes.length) return null;
    slopes.sort((a, b) => a - b);
    const rate = slopes[slopes.length >> 1];
    // Plausible broadcast rates only: 1.0 = live, >1 = ads inserted.
    if (!(rate > 0.8 && rate < 2.5)) return null;

    const intercepts = pairs
      .map((p) => p.sec - rate * (p.tMs / 1000))
      .sort((a, b) => a - b);
    const offset = intercepts[intercepts.length >> 1];

    const residuals = pairs.map((p) =>
      Math.abs(p.sec - (offset + rate * (p.tMs / 1000))));
    const sorted = [...residuals].sort((a, b) => a - b);
    const medianRes = sorted[sorted.length >> 1];
    const inliers = residuals.filter((r) => r <= Math.max(20, medianRes * 2.5)).length;

    return { rate, offset, inliers, total: n, medianResidual: medianRes };
  }

  /* Streaming players typically only expose cues for the BUFFERED region, so a
   * single scan near the start yields a narrow span -- fine for offset, too
   * narrow to trust rate. Pairs therefore accumulate across scans: scrub to a
   * different part of the recording, run it again, and the span widens. */
  let pairHistory = [];

  function mergePairs(fresh) {
    const key = (p) => Math.round(p.sec) + ":" + Math.round(p.km);
    const seen = new Set(pairHistory.map(key));
    for (const p of fresh) {
      if (!seen.has(key(p))) { pairHistory.push(p); seen.add(key(p)); }
    }
    pairHistory.sort((a, b) => a.sec - b.sec);
    return pairHistory;
  }

  function resetHistory() { pairHistory = []; }

  /* Strategy 2: the broadcast's own start timestamp.
   *
   * DRM players usually withhold captions but still leave the asset's airing
   * time in page state. That pins the OFFSET exactly; rate has to be assumed
   * 1.0, so anything spliced in (ads) accumulates as drift later in the
   * recording. Good enough to place markers roughly, and a solid base for the
   * viewer to refine with one manual anchor. */
  function calibrateFromBroadcastStart(video, bundle) {
    const probe = window.TourNavigatorProbe;
    if (!probe) return null;
    let report;
    try { report = probe.runProbe(); } catch (_) { return null; }

    const raceStartMs = Date.parse(
      (bundle.coverage && bundle.coverage.leader_first_seen_utc) || "");
    const raceEndMs = Date.parse(
      (bundle.coverage && bundle.coverage.leader_last_seen_utc) || "");
    if (!raceStartMs || !raceEndMs) return null;

    const parse = (v) => {
      if (/^\d{13}$/.test(v)) return Number(v);
      if (/^\d{10}$/.test(v)) return Number(v) * 1000;
      const ms = Date.parse(v);
      return isNaN(ms) ? null : ms;
    };

    let best = null;
    for (const c of report.startTimeCandidates || []) {
      const ms = parse(String(c.value));
      if (ms == null) continue;
      // A broadcast starts before the racing we have data for, and not more
      // than a few hours before; anything else is some unrelated timestamp.
      const lead = raceStartMs - ms;
      if (lead < 0 || lead > 5 * 3600e3) continue;
      // The whole observed race must fit inside the recording at rate 1.0.
      const endSec = (raceEndMs - ms) / 1000;
      if (!video.duration || endSec > video.duration + 900) continue;
      if (!best || c.rank < best.rank || (c.rank === best.rank && ms > best.ms)) {
        best = { ms, rank: c.rank, source: c.source };
      }
    }
    if (!best) return null;

    const secAt = (tMs) => (tMs - best.ms) / 1000;
    return {
      ok: true,
      strategy: "broadcast-start",
      confidence: "medium",
      rate: 1.0,
      inliers: 1,
      total: 1,
      medianResidual: 0,
      spanMin: Math.round((raceEndMs - raceStartMs) / 60000),
      note: `from ${best.source}; rate assumed 1.00x (ads will drift)`,
      anchors: [
        { tUtcMs: raceStartMs, videoSec: secAt(raceStartMs), label: "auto (broadcast start)" },
        { tUtcMs: raceEndMs, videoSec: secAt(raceEndMs), label: "auto (broadcast start)" },
      ],
    };
  }

  /** Full attempt. Returns a result object; never throws into the caller. */
  function autoCalibrate(video, bundle) {
    if (!video || !bundle) return { ok: false, reason: "not ready" };
    const idx = buildKmIndex(bundle);
    if (idx.length < 20) {
      return { ok: false, reason: "not enough GPS-observed route points" };
    }
    const cues = collectCues(video);
    if (!cues.length) {
      // Captions withheld (normal for DRM). Fall back to the airing time.
      const viaStart = calibrateFromBroadcastStart(video, bundle);
      if (viaStart) return viaStart;
      return {
        ok: false,
        reason: "no captions exposed and no broadcast start time found — " +
                "click Diagnose and share the report",
      };
    }
    const pairs = mergePairs(candidatePairs(cues, idx));
    if (pairs.length < 3) {
      const viaStart = calibrateFromBroadcastStart(video, bundle);
      if (viaStart) return viaStart;
      return { ok: false, reason: `only ${pairs.length} usable "km to go" mentions found`,
               cues: cues.length };
    }
    const fit = theilSen(pairs);
    if (!fit) {
      const viaStart = calibrateFromBroadcastStart(video, bundle);
      if (viaStart) return viaStart;
      return { ok: false, reason: "mentions found but no consistent fit", pairs: pairs.length };
    }

    // Express the fit as two anchors so the rest of the extension is unchanged.
    const span = pairs.map((p) => p.tMs);
    const tA = Math.min(...span), tB = Math.max(...span);
    const secAt = (tMs) => fit.offset + fit.rate * (tMs / 1000);

    // Rate is only as trustworthy as the span it was fitted over: a handful of
    // mentions inside two minutes can produce a confident-looking, useless
    // slope. Span therefore gates confidence as hard as residual does.
    const spanSec = (Math.max(...pairs.map((p) => p.tMs)) -
                     Math.min(...pairs.map((p) => p.tMs))) / 1000;
    const confidence =
      spanSec >= 3600 && fit.inliers >= 8 && fit.medianResidual <= 30 ? "high" :
      spanSec >= 900 && fit.inliers >= 5 && fit.medianResidual <= 60 ? "medium" : "low";

    return {
      ok: true,
      strategy: "captions",
      confidence,
      rate: fit.rate,
      inliers: fit.inliers,
      total: fit.total,
      medianResidual: fit.medianResidual,
      spanMin: Math.round(spanSec / 60),
      anchors: [
        { tUtcMs: tA, videoSec: secAt(tA), label: "auto (captions)" },
        { tUtcMs: tB, videoSec: secAt(tB), label: "auto (captions)" },
      ],
    };
  }

  window.TourNavigatorAutoCal = {
    autoCalibrate, buildKmIndex, kmToGoToUtc, theilSen, candidatePairs, resetHistory,
    calibrateFromBroadcastStart,
  };
})();
