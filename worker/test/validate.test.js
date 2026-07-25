/* The Worker takes untrusted POSTs from the open internet and turns them into
 * commits to a file every extension fetches and trusts. So validate() and
 * clean() are the whole security boundary, and they get tested directly.
 *
 *   node test/validate.test.js
 */
import { readFileSync } from "node:fs";

// The Worker is an ES module with a default export Cloudflare calls; pull the
// two pure functions out by evaluating the source with the export stripped,
// so the test needs no bundler and no Cloudflare runtime.
const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8")
  .replace(/export default \{[\s\S]*$/, "");
const { validate, clean } = await import(
  "data:text/javascript," + encodeURIComponent(src + "\nexport { validate, clean };"));

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const good = () => ({
  schema: 1,
  stage: 19,
  date: "2026-07-24",
  site: "www.peacocktv.com",
  duration_sec: 19225.9,
  airing_ms: 1784370600000,
  anchors: [
    { tUtcMs: 1784900000000, videoSec: 1200, kind: "kmtogo", km: 100, kmto: 100.5 },
    { tUtcMs: 1784910000000, videoSec: 10200, kind: "kmtogo", km: 20, kmto: 20.5 },
  ],
  cal: { refMs: 1784900000000, offsetSec: 1200, rate: 0.92 },
  saved_at: "2026-07-24T23:00:00.000Z",
  extension_version: "0.2.0",
});

const rejects = (label, mutate, expectFragment) => {
  const rec = good();
  mutate(rec);
  const err = validate(rec);
  check(label, err !== null && (!expectFragment || err.includes(expectFragment)),
        err || "ACCEPTED (should not have been)");
};

console.log("\n--- accepts a real record ---");
check("the extension's own payload validates", validate(good()) === null,
      validate(good()) || "");

console.log("\n--- rejects malformed / hostile input ---");
rejects("stage out of range", (r) => { r.stage = 99; }, "stage");
rejects("stage not an integer", (r) => { r.stage = "19"; }, "stage");
rejects("site with a path traversal", (r) => { r.site = "evil.com/../../etc"; }, "site");
rejects("site with a space", (r) => { r.site = "not a host"; }, "site");
rejects("loopback host (a test harness)", (r) => { r.site = "127.0.0.1"; }, "local test host");
rejects("localhost", (r) => { r.site = "localhost"; }, "local test host");
rejects("private LAN address", (r) => { r.site = "192.168.1.10"; }, "local test host");
rejects("site absurdly long", (r) => { r.site = "a".repeat(300); }, "site");
rejects("duration implausibly short", (r) => { r.duration_sec = 5; }, "duration");
rejects("duration implausibly long", (r) => { r.duration_sec = 60 * 60 * 24; }, "duration");
rejects("duration not a number", (r) => { r.duration_sec = "19225"; }, "duration");
rejects("no anchors", (r) => { r.anchors = []; }, "anchors");
rejects("anchors not a list", (r) => { r.anchors = "many"; }, "anchors");
rejects("absurdly many anchors",
        (r) => { r.anchors = Array(500).fill(r.anchors[0]); }, "anchors");
rejects("anchor beyond the recording", (r) => { r.anchors[0].videoSec = 999999; }, "videoSec");
rejects("negative anchor position", (r) => { r.anchors[0].videoSec = -5; }, "videoSec");
rejects("anchor km out of range", (r) => { r.anchors[0].km = 5000; }, "km");
rejects("anchor km not a number", (r) => { r.anchors[0].km = "100"; }, "km");
rejects("NaN smuggled in", (r) => { r.anchors[0].videoSec = NaN; }, "videoSec");
rejects("nonsense rate", (r) => { r.cal.rate = 99; }, "rate");
check("null body rejected", validate(null) !== null);
check("array body rejected", validate([1, 2, 3]) !== null);

console.log("\n--- clean() drops everything unknown ---");
const dirty = good();
dirty.evil = "<script>alert(1)</script>";
dirty.anchors[0].evil = "payload";
dirty.__proto__x = "nope";
const c = clean(dirty, "203.0.113.9");
check("unknown top-level field dropped", !("evil" in c));
check("unknown anchor field dropped", !("evil" in c.anchors[0]));
check("known anchor fields kept",
      c.anchors[0].km === 100 && c.anchors[0].kmto === 100.5 &&
      c.anchors[0].videoSec === 1200);
check("date truncated to a plain day", c.date === "2026-07-24");
check("duration rounded to 0.1s", c.duration_sec === 19225.9);
check("marked as worker-ingested", c.via === "worker");
check("submitter is not the raw IP", !String(c.submitter).includes("203.0.113.9"));
check("ingested_at stamped", typeof c.ingested_at === "string" && c.ingested_at.length > 10);

const longVer = good();
longVer.extension_version = "x".repeat(500);
longVer.saved_at = "y".repeat(500);
const c2 = clean(longVer, "");
check("oversized strings truncated",
      c2.extension_version.length <= 24 && c2.saved_at.length <= 32);

console.log("\n" + (failed ? `${failed} FAILED` : "ALL ASSERTIONS PASSED"));
process.exit(failed ? 1 : 0);
