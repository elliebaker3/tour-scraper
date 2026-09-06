# Calibration collector

Lets anyone contribute a calibration **without a GitHub account**.

The extension can't write to GitHub itself. A token shipped inside a browser
extension is readable by anyone who unpacks it, and that token would grant
write access to this repo — so it can never live there. This Worker holds it
instead, as an encrypted secret, and commits on the viewer's behalf.

```
extension  ──POST JSON──▶  <name>.workers.dev  ──token──▶  GitHub
                                   │
                          validate + rate-limit
                                   │
                    commit extension/data/calibrations.json
                                   │
extension  ◀──raw.githubusercontent.com────────────────────┘
```

Contributors need nothing: no account, no tab, no click-through. Without this
deployed the extension falls back to opening a prefilled GitHub issue, which
works but needs a login.

## Deploy

Free tier is far more than this needs (100k requests/day).

```bash
cd worker
npm install

# 1. A fine-grained PAT, scoped to THIS repo only, with Contents: read+write.
#    github.com/settings/personal-access-tokens/new
npx wrangler secret put GITHUB_TOKEN

# 2. Ship it. Note the https://tour-calibrations.<subdomain>.workers.dev URL.
npx wrangler deploy
```

Then put that URL in `extension/navigator.js`:

```js
const COLLECTOR_URL = "https://tour-calibrations.<subdomain>.workers.dev";
```

and reload the extension. A successful contribution appends `· shared` to the
panel's status line.

Optional but recommended — per-IP rate limiting needs a KV namespace:

```bash
npx wrangler kv namespace create RATE     # prints an id
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`, paste the id, and
redeploy. Without it the Worker still runs; it just doesn't rate-limit.

## What it accepts

Only the record the extension produces, and only if every field checks out:
stage 1–21, a plain hostname, a plausible recording length, 1–20 readings each
positioned inside the recording, a sane rate. Unknown fields are dropped rather
than stored — this file is fetched and trusted by every extension, so nothing
unvalidated may enter it.

The same validation exists in `.github/workflows/ingest-calibration.yml` for
the issue route. Two doors, one lock; change both together.

```bash
npm test        # 28 assertions over validate() and clean()
```

## Abuse surface, honestly

It's an unauthenticated write endpoint, so it is worth being clear about it:

- **Rate-limited** per IP (20/hour with KV bound), **size-capped** at 8 KB, and
  capped at 40 recordings per stage+site.
- **Every write is a commit.** A bad entry is visible in history and revertible
  with `git revert` — the audit trail is the real safety net.
- **A wrong-but-valid calibration is the realistic failure**, not a hostile
  one: it would make the bar sit wrong for others on that recording until
  someone overwrites it (same recording = replaced, not appended) or you revert.
- The IP is used for rate limiting and never stored; records keep only a
  truncated marker, enough to spot one source flooding the file.

If it ever does get abused, `wrangler delete` takes the endpoint away instantly
and the extension falls back to the issue route on its own.

## What gets sent

Stage number, the site's hostname, the recording's length, the km-to-go
readings and where in the recording they were taken, plus the fitted transform
and extension version. No identity, no account, no viewing history. The panel's
buttons say as much in their tooltip.

## Licensing (paywall)

The extension runs free for a stated trial, then needs a one-time $5 payment
via Stripe to keep going. Stripe processes the payment and knows the buyer;
this Worker only ever knows whether a given key string is valid -- see
`PRIVACY.md` for the full breakdown of what that means for a buyer.

Stripe has no built-in concept of a software license key (unlike Gumroad), so
this Worker builds the missing piece: it turns a webhook Stripe fires on
successful payment into a key, and gives the extension a way to check one.

### One-time setup, in Stripe's dashboard

1. **Create the product**: a one-time $5 price for "Tour Navigator unlock."
2. **Create a Payment Link** for it. Set its post-payment redirect to:
   ```
   https://<your-worker-subdomain>.workers.dev/success?session_id={CHECKOUT_SESSION_ID}
   ```
   (Stripe substitutes `{CHECKOUT_SESSION_ID}` itself -- type it literally.)
3. Put that Payment Link's URL into `PAYMENT_LINK_URL` in `extension/navigator.js`.
4. **Create a webhook** (Developers → Webhooks → Add endpoint) pointed at:
   ```
   https://<your-worker-subdomain>.workers.dev/stripe-webhook
   ```
   subscribed to the `checkout.session.completed` event. Copy its **signing
   secret** (starts `whsec_`) once created.

### Deploy-side setup

```bash
# A KV namespace to store issued license keys (separate from RATE above --
# this one is required, not optional; the licensing routes 500 without it
# rather than silently granting free access).
npx wrangler kv namespace create LICENSES
# paste the printed id into wrangler.toml's LICENSES binding, then:

npx wrangler secret put STRIPE_WEBHOOK_SECRET   # the whsec_... from step 4 above
npx wrangler deploy
```

### What it exposes

- `POST /stripe-webhook` — Stripe calls this. Verifies the request is
  genuinely from Stripe (HMAC-SHA256 over the raw body, using the signing
  secret above) before minting a key; a forged POST without a valid
  signature is rejected outright, since this is the one part of the whole
  feature actually worth attacking.
- `GET /success?session_id=...` — an HTML page (not JSON; a human lands
  here straight out of Checkout) that polls for and displays the key.
- `GET /license?session_id=...` — what that page polls; empty until the
  webhook above has landed for that session.
- `POST /verify-license {key}` — what the extension itself calls when a
  viewer enters a key; rate-limited the same way calibration submissions
  are.

```bash
npm test        # includes licensing.test.js: a genuinely Stripe-signed
                 # request verifies; wrong secret, tampered body, missing/
                 # malformed signature, and a replayed old timestamp all
                 # get rejected
```
