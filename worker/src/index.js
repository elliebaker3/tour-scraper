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

/* Session telemetry lives in a SEPARATE, PRIVATE repository.
 *
 * Calibrations must be public: the extension reads them back with no
 * credentials, so the file has to be world-readable. How one person moved
 * through a recording carries no such requirement, and publishing it would
 * put individual viewing behaviour in a permanent public git history.
 *
 * Each session is written as its OWN file rather than merged into a shared
 * one. Sessions arrive concurrently from unrelated viewers, and a
 * read-modify-write against a single file would have them clobbering each
 * other -- the same failure that cost stage 20 its telemetry. Separate paths
 * make the question impossible to get wrong.
 */
const SESSION_REPO = "elliebaker3/tour-sessions";
const MAX_SESSION_BYTES = 64 * 1024;

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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
// Both races run 21 stages, so a stage number alone doesn't say which one --
// see navigator.js's stageKey() for the client side of this. Omitted (or
// "tdf") means the Tour, which is what every submission before this field
// existed already meant; anything else must be an actual known race so a
// typo can't quietly open a new, permanent bucket in the shared file.
const KNOWN_RACES = new Set(["tdf", "vuelta"]);

function validate(rec) {
  if (typeof rec !== "object" || rec === null) return "not an object";
  if (!Number.isInteger(rec.stage) || rec.stage < 1 || rec.stage > 21) {
    return "stage must be an int 1-21";
  }
  if (rec.race != null && !KNOWN_RACES.has(rec.race)) {
    return "race must be one of: " + [...KNOWN_RACES].join(", ");
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
  // Moments a viewer flagged, as recording seconds. Collected so the sections
  // people actually mark can be studied; never served back onto anyone's bar
  // (the extension only restores its own). Bare positions, no notes.
  if (rec.favourites != null) {
    if (!Array.isArray(rec.favourites) || rec.favourites.length > 200) {
      return "favourites must be a list of at most 200 positions";
    }
    for (const f of rec.favourites) {
      const v = f && f.videoSec;
      if (typeof v !== "number" || !isFinite(v) || v < 0 || v > dur + DUR_TOL) {
        return "each flagged moment must sit inside the recording";
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
    // Only stored for a non-Tour race -- see KNOWN_RACES. Keeps every
    // existing entry, and every Tour submission from an extension that
    // predates this field, in exactly the shape they've always been.
    ...(rec.race && rec.race !== "tdf" ? { race: rec.race } : {}),
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
    favourites: Array.isArray(rec.favourites)
      ? rec.favourites.map((f) => ({ videoSec: Math.round(f.videoSec * 10) / 10 }))
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

    // Matches navigator.js's stageKey() exactly -- a Tour submission (no
    // `race`, or "tdf") lands in the same "stage-N" slot it always has;
    // anything else gets its race folded in so it can't collide with the
    // Tour's same-numbered stage.
    const key = `stage-${rec.race ? rec.race + "-" : ""}${rec.stage}|${rec.site}`;
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

/** Shape-check a session before it is written. Same principle as validate():
 *  this arrives from the open internet, so nothing is taken on faith. */
function validateSession(rec) {
  if (typeof rec !== "object" || rec === null) return "not an object";
  if (typeof rec.session_id !== "string" || !/^[\w-]{8,64}$/.test(rec.session_id)) {
    return "session_id must be a plain id";
  }
  if (rec.stage != null && (!Number.isInteger(rec.stage) || rec.stage < 1 || rec.stage > 21)) {
    return "stage must be an int 1-21";
  }
  if (typeof rec.site !== "string" || !/^[a-z0-9.-]{4,64}$/.test(rec.site)) {
    return "site must be a plain hostname";
  }
  if (typeof rec.coverage !== "object" || rec.coverage === null) return "coverage must be an object";
  if (Object.keys(rec.coverage).length > 500) return "coverage has too many buckets";
  for (const [k, v] of Object.entries(rec.coverage)) {
    if (!/^-?\d+$/.test(k)) return "coverage keys must be whole kilometres";
    if (typeof v !== "number" || !isFinite(v) || v < 0) return "coverage values must be seconds";
  }
  if (!Array.isArray(rec.events) || rec.events.length > 500) {
    return "events must be a list of at most 500";
  }
  return null;
}

async function storeSession(env, rec) {
  const day = (rec.ended || new Date().toISOString()).slice(0, 10);
  const path = `sessions/${day}/${rec.session_id}.json`;
  const body = JSON.stringify({ ...rec, received_at: new Date().toISOString() }, null, 2) + "\n";
  // A later write for the same session replaces the earlier partial one, so
  // the periodic sends and the final send converge on one file.
  let sha;
  const cur = await fetch(`https://api.github.com/repos/${SESSION_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
               "User-Agent": "tour-navigator-calibration-worker",
               Accept: "application/vnd.github+json" },
  });
  if (cur.ok) sha = (await cur.json()).sha;
  const put = await fetch(`https://api.github.com/repos/${SESSION_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
               "User-Agent": "tour-navigator-calibration-worker",
               Accept: "application/vnd.github+json" },
    body: JSON.stringify({
      message: `session ${rec.session_id.slice(0, 8)} · stage ${rec.stage} · ${rec.site}`,
      content: btoa(unescape(encodeURIComponent(body))),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) throw new Error(`write session: ${put.status}`);
}

/* Licensing: a $5 one-time Stripe payment unlocks the extension past its
 * free-trial window. Stripe has no concept of "software license keys" the
 * way Gumroad does, so this builds the missing piece on top of Stripe's raw
 * payment primitives:
 *
 *   1. Stripe calls /stripe-webhook the instant a Checkout session
 *      completes. Signature-verified (see verifyStripeSignature) so a
 *      forged POST can't mint a free license -- this is the one part of the
 *      whole feature an attacker would actually want to break.
 *   2. A license key is generated and stored in KV as {LICENSES} under two
 *      keys: `license:{key}` (what /verify-license checks) and
 *      `session:{sessionId}` (what the success page polls, since it has the
 *      session id from Stripe's redirect but not the key itself yet).
 *   3. Stripe's Checkout success URL points at /success?session_id=
 *      {CHECKOUT_SESSION_ID}, which polls /license until the webhook (2) has
 *      landed, then shows the key to paste into the extension.
 *   4. The extension calls /verify-license with whatever the viewer typed
 *      in; a match unlocks it permanently, cached locally so this endpoint
 *      is hit once per install, not once per page load.
 *
 * Storing "is this key valid" rather than anything about who bought it: no
 * email, no name, nothing tied to a person longer than Stripe's own records
 * already are.
 */

// Avoids 0/O/1/I/L -- a key gets read off a screen and typed by hand, and
// those are the pairs a person actually misreads.
const LICENSE_KEY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function generateLicenseKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += LICENSE_KEY_ALPHABET[b % LICENSE_KEY_ALPHABET.length];
  return s.match(/.{1,4}/g).join("-");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe signs each webhook with HMAC-SHA256 over "{timestamp}.{rawBody}",
 *  sent as a `Stripe-Signature: t=...,v1=...` header. Verified from raw
 *  bytes -- NOT the parsed JSON, which wouldn't reproduce the same bytes
 *  Stripe signed -- using the Web Crypto API (no Stripe SDK dependency; the
 *  official Node SDK doesn't run in the Workers runtime without a compat
 *  shim, and this is the one primitive actually needed from it). A 5-minute
 *  timestamp tolerance blocks replaying an old, captured request. */
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => kv.split("=")).filter((kv) => kv.length === 2));
  const { t: timestamp, v1: sig } = parts;
  if (!timestamp || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, sig);
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json(500, { error: "worker missing STRIPE_WEBHOOK_SECRET" });
  if (!env.LICENSES) return json(500, { error: "worker missing LICENSES binding" });
  const rawBody = await request.text();
  const ok = await verifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json(400, { error: "invalid signature" });

  let event;
  try { event = JSON.parse(rawBody); } catch { return json(400, { error: "invalid JSON" }); }

  if (event.type === "checkout.session.completed") {
    const sessionId = event.data?.object?.id;
    if (sessionId) {
      // Idempotent: Stripe retries a webhook delivery that didn't get a
      // prompt 2xx, so a session that already has a key is left alone
      // rather than issuing a second one for the same payment.
      const existing = await env.LICENSES.get(`session:${sessionId}`);
      if (!existing) {
        const key = generateLicenseKey();
        await env.LICENSES.put(`license:${key}`, "valid");
        await env.LICENSES.put(`session:${sessionId}`, key);
      }
    }
  }
  return json(200, { received: true });
}

/** Polled by the success page: has the webhook for this Checkout session
 *  landed yet? (Stripe's redirect and its webhook delivery race each
 *  other -- there's no ordering guarantee -- so the key may not exist the
 *  instant the buyer's browser arrives here.) */
async function handleLicenseLookup(url, env) {
  if (!env.LICENSES) return json(500, { error: "worker missing LICENSES binding" });
  const sessionId = url.searchParams.get("session_id") || "";
  if (!sessionId) return json(400, { error: "session_id required" });
  const key = await env.LICENSES.get(`session:${sessionId}`);
  return json(200, { key: key || null });
}

async function handleVerifyLicense(request, env) {
  if (!env.LICENSES) return json(500, { error: "worker missing LICENSES binding" });
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (await rateLimited(env, ip)) return json(429, { error: "rate limited" });
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json(400, { error: "invalid JSON" }); }
  const key = String(body?.key || "").trim().toUpperCase();
  if (!key) return json(400, { error: "key required" });
  const valid = await env.LICENSES.get(`license:${key}`);
  return json(200, { valid: !!valid });
}

/** Plain HTML, not JSON -- this is the page a human lands on straight out of
 *  Stripe Checkout, not something the extension calls. Polls its own
 *  /license endpoint client-side rather than blocking the response on it,
 *  since the webhook (racing this same redirect) might take a few seconds. */
function handleSuccessPage(url) {
  const sessionId = url.searchParams.get("session_id") || "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tour Navigator -- your license key</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; background:#0e1014;
         color:#f2f3f5; max-width:560px; margin:60px auto; padding:0 20px; }
  .key { font: 22px/1.4 ui-monospace, Menlo, monospace; background:#1b1e24; border:1px solid #333;
         border-radius:8px; padding:16px; margin:20px 0; text-align:center; letter-spacing:1px; }
  button { background:#f5a524; border:none; border-radius:6px; padding:10px 16px;
           font-size:14px; cursor:pointer; }
  .muted { color:#8f97a3; font-size:14px; }
</style></head>
<body>
  <h2>Thanks! Here's your license key</h2>
  <div id="key" class="key">Waiting for payment confirmation&hellip;</div>
  <button id="copy" style="display:none">Copy key</button>
  <p class="muted">Paste this into the Tour Navigator panel to unlock it. This page checks
  automatically every couple seconds -- no need to refresh.</p>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    async function poll() {
      if (!sessionId) { document.getElementById('key').textContent = 'No session id in URL.'; return; }
      for (let i = 0; i < 20; i++) {
        try {
          const r = await fetch('/license?session_id=' + encodeURIComponent(sessionId));
          const d = await r.json();
          if (d.key) {
            document.getElementById('key').textContent = d.key;
            const btn = document.getElementById('copy');
            btn.style.display = 'inline-block';
            btn.onclick = () => navigator.clipboard.writeText(d.key);
            return;
          }
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 2000));
      }
      document.getElementById('key').textContent =
        'Still processing -- reload this page in a moment, or check your email receipt.';
    }
    poll();
  </script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === "/success" && request.method === "GET") {
      return handleSuccessPage(url);
    }
    if (url.pathname === "/license" && request.method === "GET") {
      return handleLicenseLookup(url, env);
    }
    if (url.pathname === "/verify-license" && request.method === "POST") {
      return handleVerifyLicense(request, env);
    }
    if (request.method !== "POST") return json(405, { error: "POST only" });
    if (!env.GITHUB_TOKEN) return json(500, { error: "worker missing GITHUB_TOKEN" });

    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (await rateLimited(env, ip)) return json(429, { error: "rate limited" });

    const isSession = new URL(request.url).pathname.endsWith("/session");
    const raw = await request.text();
    const cap = isSession ? MAX_SESSION_BYTES : MAX_BODY_BYTES;
    if (raw.length > cap) return json(413, { error: "payload too large" });

    if (isSession) {
      let rec;
      try { rec = JSON.parse(raw); }
      catch { return json(400, { error: "invalid JSON" }); }
      const bad = validateSession(rec);
      if (bad) return json(400, { error: bad });
      try {
        await storeSession(env, rec);
        return json(200, { ok: true });
      } catch (e) {
        return json(502, { error: String(e.message || e) });
      }
    }

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
