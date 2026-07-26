/* Calibration collector.
 *
 * The extension can't write to GitHub itself: shipping a token inside a
 * browser extension hands repo-write to anyone who unpacks it. So the token
 * lives here instead, as an encrypted Worker secret, and the extension just
 * POSTs JSON. Contributors need no account and see no tab -- which is the
 * whole point of this existing.
 *
 * What arrives is untrusted text from the open internet, so nothing is taken
 * on faith: every field is shape-checked (validate()), the payload is size-
 * capped, submissions are rate-limited per IP, and a stage+site can only hold
 * so many recordings. Everything lands as a normal commit, so a bad entry is
 * visible in history and revertible -- the audit trail IS the safety net.
 *
 * Deploy:
 *   cd worker && npm install && npx wrangler secret put GITHUB_TOKEN
 *   npx wrangler deploy
 * The token needs contents:write on this repo ONLY -- a fine-grained PAT
 * scoped to elliebaker3/tour-scraper, nothing else.
 */

const REPO = "elliebaker3/tour-scraper";
const FILE = "extension/data/calibrations.json";
const BRANCH = "main";

// A recording is one entry; two entries whose durations are within this are
// the same recording (the extension uses the same tolerance to match).
const DUR_TOL = 30;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_RECORDINGS_PER_KEY = 40;

// Per-IP budget. Generous for a real viewer (a stage takes a handful of
// readings), stingy for anything trying to fill the file with noise.
const RATE_LIMIT = 20;
const RATE_WINDOW_SEC = 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/** Reject anything that isn't the record the extension produces. Mirrors the
 *  validation in .github/workflows/ingest-calibration.yml -- the issue route
 *  still exists, and both doors need the same lock. */
function validate(rec) {
  if (typeof rec !== "object" || rec === null) return "not an object";
  if (!Number.isInteger(rec.stage) || rec.stage < 1 || rec.stage > 21) {
    return "stage must be an int 1-21";
  }
  if (typeof rec.site !== "string" || !/^[a-z0-9.-]{4,64}$/.test(rec.site)) {
    return "site must be a plain hostname";
  }
  // A loopback or private host is a development harness, not a broadcaster.
  // Nobody watches a stage on 127.0.0.1, so such a record can only be a test
  // -- and letting one in means every real viewer then fetches it. (This
  // repo's own extension test suite POSTed several before it was added.)
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|localhost$)/.test(rec.site)) {
    return "site looks like a local test host, not a broadcaster";
  }
  const dur = rec.duration_sec;
  if (typeof dur !== "number" || !isFinite(dur) || dur <= 600 || dur >= 12 * 3600) {
    return "duration_sec must be a plausible recording length";
  }
  if (!Array.isArray(rec.anchors) || rec.anchors.length < 1 || rec.anchors.length > 20) {
    return "anchors must be a list of 1-20 readings";
  }
  for (const a of rec.anchors) {
    if (typeof a !== "object" || a === null) return "anchor must be an object";
    if (typeof a.videoSec !== "number" || !isFinite(a.videoSec) ||
        a.videoSec < 0 || a.videoSec > dur + DUR_TOL) {
      return "each anchor needs a videoSec inside the recording";
    }
    if (typeof a.km !== "number" || !isFinite(a.km) || a.km < 0 || a.km > 400) {
      return "each anchor needs a plausible km";
    }
  }
  if (rec.cal != null) {
    const c = rec.cal;
    if (typeof c !== "object") return "cal must be an object or null";
    if (typeof c.rate !== "number" || !isFinite(c.rate) || c.rate < 0.3 || c.rate > 2) {
      return "cal.rate is out of range";
    }
  }
  // Ad-break boundaries, in recording seconds. These carry the LOCAL layer:
  // without them a restored reading can only refit the global rate, so they
  // are as much a part of the contribution as the readings themselves. A long
  // broadcast can carry a lot of breaks -- a stage has been observed with
  // nearer 30 -- so this bound only rejects a list that could not be breaks.
  if (rec.ad_breaks != null) {
    if (!Array.isArray(rec.ad_breaks) || rec.ad_breaks.length > 120) {
      return "ad_breaks must be a list of at most 120 positions";
    }
    for (const b of rec.ad_breaks) {
      if (typeof b !== "number" || !isFinite(b) || b < 0 || b > dur) {
        return "each ad break must sit inside the recording";
      }
    }
  }
  return null;
}

/** Keep only known fields: whatever else the body carried never reaches the
 *  file every extension trusts. */
function clean(rec) {
  const keep = ["tUtcMs", "videoSec", "kind", "km", "kmto", "label"];
  return {
    schema: 1,
    stage: rec.stage,
    date: typeof rec.date === "string" ? rec.date.slice(0, 10) : null,
    site: rec.site,
    duration_sec: Math.round(rec.duration_sec * 10) / 10,
    airing_ms: Number.isFinite(rec.airing_ms) ? rec.airing_ms : null,
    anchors: rec.anchors.map((a) => {
      const o = {};
      for (const k of keep) if (a[k] !== undefined) o[k] = a[k];
      return o;
    }),
    cal: rec.cal ?? null,
    ad_breaks: Array.isArray(rec.ad_breaks)
      ? [...new Set(rec.ad_breaks.map((b) => Math.round(b)))].sort((a, b) => a - b)
      : [],
    saved_at: typeof rec.saved_at === "string" ? rec.saved_at.slice(0, 32) : null,
    extension_version: typeof rec.extension_version === "string"
      ? rec.extension_version.slice(0, 24) : null,
    ingested_at: new Date().toISOString(),
    via: "worker",
    // Nothing derived from the submitter's IP is kept. A truncated prefix
    // used to live here to spot one source flooding the file, but it earned
    // very little -- the git history is the real audit trail -- and it wrote
    // an IP-derived value into a PUBLIC repository, permanently. That is a
    // poor trade for a diagnostic, and it made the extension's privacy
    // disclosure harder to state honestly. The address is still read in
    // memory for rate limiting and then discarded.
  };
}

async function rateLimited(env, ip) {
  if (!env.RATE || !ip) return false;           // no KV bound: skip, don't fail
  const key = `rl:${ip}`;
  const n = Number((await env.RATE.get(key)) || 0);
  if (n >= RATE_LIMIT) return true;
  await env.RATE.put(key, String(n + 1), { expirationTtl: RATE_WINDOW_SEC });
  return false;
}

const gh = (env, path, init = {}) =>
  fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tour-navigator-calibration-worker",
      ...(init.headers || {}),
    },
  });

/** Read calibrations.json, merge this record, write it back.
 *
 *  GitHub's contents API takes the blob SHA we read as a precondition, so a
 *  concurrent submission fails with 409 rather than silently clobbering the
 *  other one -- hence the retry around the whole read-merge-write cycle. */
async function merge(env, rec) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await gh(env, `contents/${FILE}?ref=${BRANCH}`);
    if (!cur.ok) throw new Error(`read ${FILE}: ${cur.status}`);
    const meta = await cur.json();

    /* Read the body as TEXT, not from the inline base64.
     *
     * Two things went wrong with `JSON.parse(atob(meta.content))`. Above 1MB
     * the contents API stops inlining altogether -- it answers
     * `encoding: "none"` with an empty content field -- so the parse got an
     * empty string and every submission failed with a 502, which the
     * extension correctly read as "collector unreachable" and fell back to
     * opening a GitHub issue.
     *
     * Below that it was quietly corrupting instead: writes encode UTF-8
     * (`btoa(unescape(encodeURIComponent(...)))`) but atob() alone does not
     * decode it, so every non-ASCII character came back as mojibake and was
     * re-encoded larger on the next write. One ellipsis reached 4.7MB that
     * way, which is what pushed the file over the limit in the first place.
     *
     * Fetching download_url sidesteps both: proper text, any size. The blob
     * sha still comes from the metadata, so the write precondition is
     * unchanged.
     */
    const raw = await fetch(meta.download_url, {
      headers: { "User-Agent": "tour-navigator-calibration-worker" },
    });
    if (!raw.ok) throw new Error(`read body ${FILE}: ${raw.status}`);
    const store = JSON.parse(await raw.text());

    const key = `stage-${rec.stage}|${rec.site}`;
    store.recordings = store.recordings || {};
    const list = store.recordings[key] || (store.recordings[key] = []);
    const i = list.findIndex(
      (e) => Math.abs((e.duration_sec || 0) - rec.duration_sec) <= DUR_TOL);
    if (i >= 0) list[i] = rec;
    else if (list.length >= MAX_RECORDINGS_PER_KEY) {
      return { ok: false, reason: "too many recordings already stored for this stage+site" };
    } else list.push(rec);

    const body = JSON.stringify(store, null, 2) + "\n";
    const put = await gh(env, `contents/${FILE}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `calibrations: stage ${rec.stage} · ${rec.site} · ` +
                 `${Math.round(rec.duration_sec)}s (via worker)`,
        content: btoa(unescape(encodeURIComponent(body))),
        sha: meta.sha,
        branch: BRANCH,
      }),
    });
    if (put.ok) return { ok: true, replaced: i >= 0 };
    if (put.status !== 409) throw new Error(`write ${FILE}: ${put.status}`);
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));   // raced; re-read
  }
  return { ok: false, reason: "contended, try again" };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json(405, { error: "POST only" });
    if (!env.GITHUB_TOKEN) return json(500, { error: "worker missing GITHUB_TOKEN" });

    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (await rateLimited(env, ip)) return json(429, { error: "rate limited" });

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload too large" });

    let rec;
    try { rec = JSON.parse(raw); }
    catch { return json(400, { error: "invalid JSON" }); }

    const bad = validate(rec);
    if (bad) return json(400, { error: bad });

    try {
      const res = await merge(env, clean(rec));
      return res.ok
        ? json(200, { ok: true, replaced: res.replaced })
        : json(409, { error: res.reason });
    } catch (e) {
      return json(502, { error: String(e.message || e) });
    }
  },
};
