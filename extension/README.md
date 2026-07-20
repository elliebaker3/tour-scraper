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

## Calibrate: one reading

Pause anywhere the broadcast is showing **km to go**, type that number in, and
press **Calibrate**. That is the entire setup.

Until you do, the panel shows the prompt and nothing else — no bar, no markers.
A profile with no clock invites reading positions off it that are not real,
which is how every "the elevation doesn't line up" problem started.

One reading is enough because the broadcast has no inserted breaks, so race
time and recording time differ by an offset alone. The profile knows when the
leader was at any km-to-go, so your recording position paired with that race
time fixes the offset, and everything else follows.

**Accuracy is bounded by the graphic, not the data.** It counts in whole
kilometres, so "42" means somewhere in [42, 43); the midpoint is used, leaving
about ±45 s at racing speed. Type a decimal if the graphic shows one and that
uncertainty disappears.

**Add readings to refine.** After calibrating, a compact field takes more
readings from elsewhere in the stage. The **median** is used, so rounding that
falls either way cancels and one misread number cannot move the timeline. The
status line reports how many readings are in play and how far apart they
disagree — a spread under a minute across the whole stage means the
calibration is sound end to end.

**reset** clears it and returns to the prompt. Calibration is not remembered
across reloads — it is one number, and every load starts by asking for the
current km-to-go rather than restoring a stale one.

## What the bar shows

The stage elevation profile against **recording time**, so every position on it
is a moment you can seek to. Click anywhere to jump there; click a marker to
jump to that event.

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

Collapsing (**–**) keeps the profile as a slim strip and hides the controls.

Tests (need Playwright):

    python tests/test_extension_ui.py

## Adding stages

`data/index.json` lists the shipped bundles and their dates; the panel matches
the asset's airing date against it. To add a stage:

```bash
python -m tourscraper navigator --stage 16 \
  --stage-dir data/2026/stage-16_2026-07-21 \
  --telemetry data/2026/stage-16_2026-07-21/polls/telemetry.jsonl
cp data/2026/stage-16_2026-07-21/navigator.json extension/data/stage-16.json
# then append it to extension/data/index.json
```

Then hit reload on the extension card.

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
