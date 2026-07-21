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

## Calibrate: usually one "km to go" reading

Pause where the broadcast shows **km to go**, type that number in and press
**Calibrate**. On Peacock that is normally the whole setup.

**Why one reading is enough.** The recording plays the race at true 1:1; the
only discontinuities are the ad breaks, where a chunk of race is missing (it
happened live while ads played). Peacock exposes every ad break on a metadata
track (`cvsdk::ad-break-*`), and the extension reads their exact positions
straight from the player. So the breaks locate themselves — the one thing a
reading supplies is the origin (where the race sits against the recording).
Each break is assumed to cost its own length of race, which is the physical
case, so a single reading places the entire stage. The panel shows how many
breaks it found (`21 ad breaks from the player`).

**A second reading only refines.** If a break costs a bit more or less than its
length, add one reading on the far side of a break with **Add reading** and the
extension fits that factor across all of them. The status shows it
(`~80% of each break lost to race`). More readings least-squares it further.

**If the ad-break track isn't there** (a non-Peacock player, or Peacock changes
its markup), it falls back to locating cuts from the readings themselves: rate 1
between breaks, a step wherever two readings disagree — so you place one reading
per ad-break-free stretch. The panel says which mode it's in.

**Accuracy is bounded by the graphic.** It counts in whole kilometres, so "42"
means [42, 43); the midpoint is used. Readings in the same stretch are averaged.

**reset** clears it. Calibration is not remembered across reloads — every load
asks for the current km-to-go rather than restoring a stale one.

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
