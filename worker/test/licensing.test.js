/* The licensing endpoints turn a Stripe payment into an unlock code, and the
 * ONE thing an attacker would actually want to break is the webhook
 * signature check -- without it, anyone could POST a fake "payment
 * succeeded" event and mint themselves a free license. So that check gets
 * tested directly, the same way validate.test.js tests the calibration
 * boundary.
 *
 *   node test/licensing.test.js
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8")
  .replace(/export default \{[\s\S]*$/, "");
const { generateLicenseKey, timingSafeEqual, verifyStripeSignature } = await import(
  "data:text/javascript," + encodeURIComponent(
    src + "\nexport { generateLicenseKey, timingSafeEqual, verifyStripeSignature };"));

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

console.log("\n--- generateLicenseKey() ---");
const keys = new Set(Array.from({ length: 200 }, generateLicenseKey));
check("right shape: XXXX-XXXX-XXXX-XXXX",
      /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test([...keys][0]),
      [...keys][0]);
check("no ambiguous characters (0/O/1/I/L) in a real sample",
      ![...keys].some((k) => /[01OIL]/.test(k)));
check("200 draws, no collisions", keys.size === 200);

console.log("\n--- timingSafeEqual() ---");
check("equal strings match", timingSafeEqual("abc123", "abc123"));
check("different strings don't", !timingSafeEqual("abc123", "abc124"));
check("different lengths don't (and don't throw)", !timingSafeEqual("abc", "abcd"));

console.log("\n--- verifyStripeSignature(): the actual security boundary ---");
const SECRET = "whsec_test_secret_value";
const BODY = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } });

function realStripeSigHeader(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

check("a genuinely Stripe-signed request verifies",
      await verifyStripeSignature(BODY, realStripeSigHeader(BODY, SECRET), SECRET));
check("wrong secret is rejected",
      !(await verifyStripeSignature(BODY, realStripeSigHeader(BODY, "wrong_secret"), SECRET)));
check("tampered body is rejected (signature no longer matches)",
      !(await verifyStripeSignature(BODY + "x", realStripeSigHeader(BODY, SECRET), SECRET)));
check("missing signature header is rejected",
      !(await verifyStripeSignature(BODY, null, SECRET)));
check("malformed header (no v1) is rejected",
      !(await verifyStripeSignature(BODY, "t=123456789", SECRET)));
check("replayed old timestamp is rejected (5min tolerance)",
      !(await verifyStripeSignature(BODY, realStripeSigHeader(BODY, SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET)));
check("a forged event with no real signature at all is rejected",
      !(await verifyStripeSignature(BODY, "t=" + Math.floor(Date.now() / 1000) + ",v1=" + "0".repeat(64), SECRET)));

console.log("\n" + (failed ? `${failed} FAILED` : "ALL ASSERTIONS PASSED"));
process.exit(failed ? 1 : 0);
