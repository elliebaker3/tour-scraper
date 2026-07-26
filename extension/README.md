# Tour Navigator (browser extension)

Replaces the one thing a scrub bar tells you (percent elapsed) with the things
you actually navigate by: the stage's elevation profile plotted against
**recording time**, with markers for crashes, attacks, catches, scenery,
history, and a strip showing where the race got intense.

It reads `video.currentTime` and sets it to seek. It does not capture,
download or modify any stream.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Open your stage recording. The panel pins to the bottom of the window.

## Calibrate: "km to go" readings

Pause where the broadcast shows **km to go**, type that number in and press
**Add reading**. One reading is enough to be useful; a second one far away --
near the finish is ideal -- fits the rate itself and is the accurate setup.

The bar draws before any of that, from the broadcast's own shape (see *The
clock: two layers* below), and says what it is assuming while it does. A
reading refines that rather than unlocking it.

**Why a second one helps.** The recording does *not* run 1:1 with race time.
On stage 14 it advances at **0.918x** -- about 20 minutes of racing is missing,
spread across the stage as ad breaks. One reading fixes where the profile sits
and keeps the assumed 0.92x rate, which is already close everywhere. A second
reading far from the first supplies the measured **rate**: the extension fits
recording-second against race-time across both, and the status line then shows
it (`rate 0.918x`) with how well the readings agree (`fits to +/-3s`).

**Accuracy is bounded by the graphic.** It counts in whole kilometres, so "42"
means somewhere in [42, 43); the midpoint is used. Two readings far apart divide
that rounding across a long baseline, so it barely affects the rate -- but two
readings *close together* cannot fix the rate, and the panel says so and falls
back to offset-only.

**reset** clears this recording's readings and returns to the stated default --
it does not blank the bar, because the default is still a clock. Calibrations
*are* remembered, per recording; see below.

## What the bar shows

The stage elevation profile against **recording time**, so every position on it
is a moment you can seek to. Click anywhere to jump there; click a marker to
jump to that event.

**Sprints and climbs are marked on the curve itself**, the way a printed stage
profile flags them: a green **S** at each intermediate sprint, and at every
categorized climb a badge with its grade (`HC`, `1`–`4`, or 🏁 for a summit
finish), coloured hardest-red to easiest-yellow, sitting at the summit's real
altitude. These come from ASO's own route data (`route_markers` in the bundle),
so they are exact and independent of the ticker — and of the downsampling that
had been dropping them. Click one to seek to when the leader reached it.

Distances are always **km remaining to the line**, never km travelled — that is
how a race is called. They come from the profile's `kmto` column rather than
`stage_length - km`: stages.json says 155.5 for stage 14 where the route file
says 155.2, and adopting that 0.3 km would reintroduce the constant offset the
sync exists to remove. The x axis still runs start → finish left to right, so
the silhouette matches a published profile while the labels count down.

Two weights, two different claims:

| | meaning |
|---|---|
| solid | GPS-observed |
| solid, dimmer | estimated — GPS was offline, pace inferred from the known start |

State that used to sit in a strip of text beside the buttons now rides in the
diag line, along with transient feedback on a reading, which clears after a few
seconds.

Both are drawn solid. Dashes read as a broken trace rather than as lower
confidence, and the silhouette is the thing being read; the estimated stretch
stays dimmer and the diag line names it outright.

The profile covers the part of the recording the **race** covers, not the whole
bar. The build-up before the flag and the coverage after the line are left
empty rather than filled flat, so where the silhouette begins is where the race
begins — and the playhead lines up with the player's own position.

Profile-only stages do this too. Even uncalibrated they assume the Peacock
shape — the flag an hour in, then the scheduled race duration at 0.92x — so
the bar is a recording timeline from the start and the playhead shows where
you are watching. Two readings replace the assumption with the measured thing,
which is why the prompt still asks for them.

There is a margin at the right-hand end of the bar so a finish-line label has
somewhere to sit. Everything positional maps into that reduced width, playhead
and click targets included, so the drawing area shrinks as one piece.

Every climb is drawn in the same deep red whatever its grade; the grade is on
the badge, so colouring by it was saying the same thing twice at the cost of
the climbs reading as one kind of thing. Badges and names always sit above the
line.

Hovering reads out `77.8 km to go · 677m · 13:34Z · rec 2:14:07`. The clock
names the gradient under the playhead (`6.5 km to go · climbing 9.0%`); if the
screen shows a climb and that says descending, the reading was off.

The panel always states what it is assuming:

    stage 14 (2026-07-18) · rate 0.918× · no ad breaks found — global rate only · matched airing date

The panel **rides with the player's controls**: it fades in when you move the
mouse and out after a few seconds of stillness, sitting just above the player's
own scrub bar, so it is there when you're scrubbing and gone when you're
watching. Hovering it keeps it up.

**Sprints and climbs are shown by default; nothing else is.** The elevation
graphic (profile + sprint/climb markers) is always on; crashes, attacks,
catches, scenery and contenders each have a checkbox that starts off, so the
bar is the profile and nothing else until you opt into a kind. Collapsing (**–**) keeps the profile as a slim strip.

Tests (need Playwright):

    python tests/test_extension_ui.py
    python tests/test_calibration_persist.py

## The clock: two layers

**Global** — one universal rate across the whole race. With no readings it is
the broadcast's own shape: about an hour of build-up before the flag, then
0.92x, since roughly 8% of race time goes to ad breaks. Readings refine that
rate by least-squares fit. This governs everywhere by default, and it is what
keeps a single reading usable across a whole stage.

**Local** — inside one ad-bracketed interval only. Between two breaks the
broadcast runs at real time, so a reading taken in that interval is an exact
anchor and time runs 1x from it to the interval's edges. At those edges the
global rate resumes. Local wins wherever it applies, so readings in different
intervals each govern their own, and every reading still refits the global
rate on top.

### When it says "no ad breaks found"

Detection looks for a narrow, full-height tick inside the player's own seek
bar — that is what a break marker is on every player that draws one, and it
does not depend on what anyone called the class. If the panel still reports
none, run this in the console with the controls showing:

    __tnAdDebug()

It prints the seek bar it locked onto and a table of every element inside it,
with why each was kept or dropped. Three outcomes:

* **the real markers are in the table, marked dropped** — the shape test is
  too strict; paste the table back and it can be widened.
* **the table is empty or has no ticks** — the markers live outside the seek
  bar element, or are painted rather than built from DOM. Paste the seek bar
  line instead.
* **"no seek bar found"** — it prints the wide, low elements that could be
  one; paste those.

In Chrome the content script runs in its own world, so pick **Tour Navigator**
in the console's context dropdown (next to the filter box) before running it,
or `__tnAdDebug` will be undefined.

The local layer is only as real as the break boundaries, so it stays dormant
until they are actually detected — an interval with invented edges would drift
silently, which is the failure the whole model exists to avoid. Boundaries
come from the player's own scrub bar, which ticks where the breaks are
(`detectAdBreaks`). With none found the panel says so and behaves exactly as
the global model alone.

The break positions are stored and shared alongside the readings, so the next
viewer of the same recording inherits both layers, not just the rate.

## Calibration is remembered, per recording

Calibrate once and that's it: the readings are saved and reapplied
automatically next time, bar up immediately with a note saying where the
numbers came from. Reset is one click if it ever looks wrong.

The thing that makes this safe is **what it is keyed by**. A calibration
belongs to one *recording* — `(stage, site, duration)` — not to a stage. Open
a different cut, or the same stage on another site, and the saved numbers are
correctly ignored: that recording gets the normal prompt and its own slot, and
both are kept side by side. An earlier version keyed by stage alone, restored
one recording's offset onto another, and that is why persistence had been
removed entirely; keying it properly is the actual fix. Duration is the
fingerprint — the same asset reopened matches within a second or two, where a
different cut differs by minutes (30s tolerance).

Two tiers are consulted, local first:

| tier | where | when |
|---|---|---|
| this browser | `chrome.storage.local` | your own past calibration of this exact recording |
| shared store | `data/calibrations.json`, fetched live from the repo | someone else already calibrated this same recording |

The shared store is what makes a stage self-calibrating for everyone watching
the same broadcast. There is no separate share control: **Add reading**
contributes as it calibrates. Because the extension re-fetches
`calibrations.json` from `raw.githubusercontent.com` on every load (the bundled
copy is only the offline fallback), a merged calibration reaches every viewer
without an extension update.

An extension can't hold a GitHub token — anyone who unpacks it could read it
and write to the repo — so contributing goes one of two ways:

| route | needs an account? | when |
|---|---|---|
| `COLLECTOR_URL` → the Worker in [`worker/`](../worker) | no | whenever it's deployed. One silent POST; the Worker holds the token and commits. Status line says `· shared`. |
| prefilled GitHub issue | yes | fallback, when no collector is set or it's unreachable. `ingest-calibration.yml` validates and merges it. |

When the collector fails, the panel says so rather than just falling back:
`⚠ collector said 502: … — opening the issue form instead`, quoting the
reason verbatim. A 400 names the field it objected to; a 5xx means the
collector itself is unwell rather than the record being bad. Without that,
every failure looked identical to having no collector configured at all,
which hid a broken one behind a working fallback.

`COLLECTOR_URL` is empty until you deploy the Worker — see
[worker/README.md](../worker/README.md), it's about ten minutes and free. Until
then the issue route is used: its tab is **named**, so a second reading reuses
it rather than stacking tabs, and an identical payload never reopens it.
Opening that tab publishes nothing on its own, so someone without an account
just closes it and keeps the calibration locally, which still works fully.

Either way a contribution carries the stage, the site's hostname, the recording
length, the readings and the fitted transform — no identity, no account, no
viewing history. Both buttons say so in their tooltip, since a control labelled
"Add reading" that also publishes should not be a surprise to anyone but you.

Each stored record carries the stage, date, site, duration fingerprint, the
airing timestamp, every km-to-go reading, the ad-break positions, the fitted
transform, and the extension version that produced it — enough to audit or
re-fit later.

**The km is what is trusted on the way back in.** A reading stores both the
number you typed and the race time the profile said it meant, but only the
first is input — the second is derived, and is only as good as the bundle that
produced it. So it is recomputed against whatever bundle is loaded now. Stage
20's readings were saved against a bundle whose telemetry had been clobbered,
and restoring those stale times fitted a rate of 0.42 that clamped to the 0.5
floor and drew the whole race squeezed into half the bar. Re-deriving keeps
every reading and fixes the fit — and makes a shared calibration safe to adopt
from someone whose bundle differed from yours, since what travels is what they
read off the screen rather than their copy's idea of when that was.

## Adding stages

`data/index.json` lists the shipped bundles and their dates; the panel matches
the asset's airing date against it. To add a stage:

```bash
python -m tourscraper navigator --stage 16 \
  --stage-dir data/2026/stage-16_2026-07-21 \
  --telemetry data/2026/stage-16_2026-07-21/polls/telemetry.jsonl
cp data/2026/stage-16_2026-07-21/navigator.json extension/data/stage-16.json
# then append it to extension/data/index.json (with "kind": "full")
```

Then hit reload on the extension card.

Every stage WITHOUT a full bundle appears in the picker anyway, marked
"— profile only": a distance/elevation profile built from velowire.com's KMZ
(see the repo README, source 5), with climb, sprint and finish markers. These
lite bundles are `data/profile-stage-NN.json` (`"kind": "profile"` in the
index), regenerated with `python -m tourscraper velowire-profiles`, which
leaves every full bundle's index entry alone. When a stage later gets a real
capture, add its full bundle as above and the picker upgrades it.

**Lite stages calibrate too**, just against a different clock. With no
telemetry there is no race time to map, so a km-to-go reading pins that
distance straight onto a recording second. Two readings, far apart, give a
piecewise-linear distance↔time map — and with it a playhead, click-to-seek,
and clickable markers, the same as a full stage. What it cannot do is know
the pace *between* readings: it assumes steady progress, which is crude on a
mountain stage, so more readings around the terrain changes tighten it. One
reading alone is stored but deliberately draws no playhead — a single pin
plus a guessed speed would place it somewhere confidently wrong.

## Honest limits

- **The rendering and clock are tested; the player integration is not.**
  `tests/test_extension_ui.py` drives the real extension in headless Chromium
  against a synthetic `<video>` and the real stage 14 bundle, asserting the
  setup gate, the km-to-go calibration against a known origin, full-width
  coverage and the km-to-go readouts. What it cannot cover is Peacock's own
  DOM: if the panel doesn't appear, `findVideo()` is the place to look. The
  panel floats over the page rather than injecting into the player's controls,
  specifically so their markup changes can't break it.
- **A reading inside the first 50 minutes is weaker.** Stage 14's GPS starts
  31 km in, so the head is estimated from the known start time and a reading
  taken there inherits that inferred pace. The status line says so when it
  happens; prefer a reading from GPS-covered road.
- **Guidepost quality is only as good as the ticker.** Categories come from
  ASO's own tags plus text patterns. Attacks over-trigger somewhat (any
  "attack" phrasing counts); crashes are sparse because the ticker reports
  fewer of them than a commentator mentions.
- **Scenery is inferred, not heard.** There is no commentary audio in this
  pipeline. "Scenic" means ASO published a timestamped photo/video of the
  peloton, crowd or landscape, or the leader crossed a summit — both good
  proxies for when the world feed shows the view, since that feed is universal.
- **Coverage gaps show as gaps.** Profile points the GPS never observed are
  marked interpolated and omitted rather than faked.
