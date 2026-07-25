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

## Calibrate: two "km to go" readings

Pause where the broadcast shows **km to go**, type that number in and press
**Calibrate**. Then do it once more from a point **far away** -- near the finish
is ideal -- with the **Add reading** field. Two readings is the accurate setup.

Until the first reading the panel shows the prompt and nothing else -- no bar,
no markers. A profile with no clock invites reading positions off it that are
not real, which is how every "the elevation doesn't line up" problem started.

**Why two, not one.** The recording does *not* run 1:1 with race time. On stage
14 it advances at **0.918x** -- about 20 minutes of racing is not in the
recording, spread across the stage. One reading fixes where the profile sits
(the offset) but has to *assume* the 1:1 rate, so it is exact at that one point
and drifts as you move away: a few kilometres of gap within an hour, more toward
the ends. That drift is the "large gaps between the bar and the screen" symptom.
A second reading far from the first supplies the **rate** -- the extension fits
recording-second against race-time across both -- and the gap closes over the
whole stage. The status line then shows the fitted rate (`rate 0.918x`) and how
well the readings agree (`fits to +/-3s`).

**Accuracy is bounded by the graphic.** It counts in whole kilometres, so "42"
means somewhere in [42, 43); the midpoint is used. Two readings far apart divide
that rounding across a long baseline, so it barely affects the rate -- but two
readings *close together* cannot fix the rate, and the panel says so and falls
back to offset-only.

**reset** clears it and returns to the prompt. Calibration is not remembered
across reloads -- every load asks for the current km-to-go rather than restoring
a stale one.

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

Three weights, three different claims:

| | meaning |
|---|---|
| solid | GPS-observed |
| dashed, dimmer | estimated — GPS was offline, pace inferred from the known start |
| faint, fine dashes | imputed — no race happening then (build-up, post-finish) |

Hovering reads out `77.8 km to go · 677m · 13:34Z · rec 2:14:07`. The clock
names the gradient under the playhead (`6.5 km to go · climbing 9.0%`); if the
screen shows a climb and that says descending, the reading was off.

The panel always states what it is assuming:

    stage 14 (2026-07-18) · rec 0:00 = 10:36:29Z · rate 1.000× · matched airing date

The panel **rides with the player's controls**: it fades in when you move the
mouse and out after a few seconds of stillness, sitting just above the player's
own scrub bar, so it is there when you're scrubbing and gone when you're
watching. Hovering it keeps it up.

**Sprints and climbs are shown by default; race events are not.** The elevation
graphic (profile + sprint/climb markers) is always on; crashes, attacks,
catches and scenery each have a checkbox that starts off, so the bar is calm
until you opt into a kind. Collapsing (**–**) keeps the profile as a slim strip.

Tests (need Playwright):

    python tests/test_extension_ui.py
    python tests/test_calibration_persist.py

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
contributes as it calibrates, opening a prefilled GitHub issue holding the
record. The `ingest-calibration` workflow validates it, merges it into
`calibrations.json` and closes the issue. Because the extension fetches that
file fresh from `raw.githubusercontent.com` on every load (the bundled copy is
only the offline fallback), a merged calibration reaches every viewer without
an extension update. An extension has no credentials to push with, which is
why contributing routes through an issue rather than a direct write.

The share tab is **named**, so a second reading reuses it rather than stacking
tabs, and an identical payload never reopens it. Opening the tab publishes
nothing — the issue still has to be submitted, which needs a GitHub login, so
contributors without an account simply close it and keep the calibration
locally. Both buttons say so in their tooltip; anyone but you running this
should know a click offers to publish.

Each stored record carries the stage, date, site, duration fingerprint, the
airing timestamp, every km-to-go reading, the fitted transform, and the
extension version that produced it — enough to audit or re-fit later.

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
