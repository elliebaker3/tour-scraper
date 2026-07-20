# Tour Navigator (browser extension)

Replaces the one thing a scrub bar tells you (percent elapsed) with the things
you actually navigate by: the stage's elevation profile plotted against
**recording time**, with markers for crashes, attacks, catches, scenery,
history, and a strip showing where the race got intense.

It reads `video.currentTime` and sets it to seek. It does not capture,
download or modify any stream.

## Calibrate from the "km to go" on screen

Pause anywhere, read the kilometres-to-go off the broadcast graphic, type it in
and press **km to go**. That is the whole calibration. Optionally put a
recording time in the box before it (`3:46:30`) to calibrate at a moment other
than where you are.

This is the primary route because the graphic is on screen almost continuously,
where km 0 and the finish each happen once and have to be hunted for. The
profile knows when the leader was at any km-to-go, so the pair — your recording
time, its race time — is an anchor.

**Accuracy is bounded by the graphic, not by the data.** It counts in whole
kilometres, so "42" means somewhere in [42, 43); the midpoint is used, leaving
about ±45 s at racing speed. Add pins from several points in the stage and the
**median** is used, so rounding that falls either way cancels and one misread
number cannot move the timeline. The status line reports how many pins are in
play and how far apart they disagree.

Alternatively pin the flag drop: scrub to it and click **"Km 0 is NOW"**, or
type its recording time and press **Set**.

One moment is enough because the broadcast has no inserted breaks, so rate is
1.0 by construction. Fitting a rate from two pins was worse than not fitting
one: it turned a few seconds of click imprecision into a slope applied across
four hours, and on stage 14 produced 0.918× — "20 minutes of racing missing" —
out of a single mis-click.

**Nothing calibrates itself on load.** The player's own `displayStartTime` was
27 minutes adrift of the recording's real origin, which put every summit on a
descent with nothing on screen to say so. A confidently wrong clock is worse
than an absent one, so the bar asks rather than guesses.

The panel always states what it is assuming:

    stage 14 (2026-07-18) · rec 0:00 = 10:36:29Z · rate 1.000× · matched airing date

and once calibrated the clock names the gradient under the playhead
(`6.5 km to go · climbing 9.0%`). If the screen shows a climb and that says
descending, the pins are off.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Open your stage recording. The panel pins to the bottom of the window.

## Calibrate automatically from captions (other players)

Click **Auto-calibrate**. It scans the caption track for "N kilometres to go"
phrases; since the GPS data knows exactly when the leader was at any km-to-go,
each mention is a candidate (recording second -> race time) pair. Dozens of
them are fitted with Theil-Sen — a median-of-slopes fit that shrugs off the
commentator rounding, referring to a chase group, or repeating a stale number —
to recover offset *and* rate in one go.

The status line reports what it found, e.g.
`auto · 1.079× · high confidence (31/40 mentions over 229min, ±21s)`.

* **rate** — 1.000× means the recording tracks race time; 1.079× means ~8% of
  it is ads/breaks.
* **span** — how far apart the mentions were. Rate is only as trustworthy as
  the span it was fitted over, so this gates the confidence rating as hard as
  the residual does.
* **±Ns** — typical placement error. ~20-30s is normal and expected:
  commentary rounds ("just over 40k") where the data is exact.

Streaming players usually only expose cues for the *buffered* region, so a
first scan may cover a narrow span. Pairs accumulate across scans — scrub to a
different part of the recording, click Auto-calibrate again, and the span (and
confidence) widen. **reset** clears both anchors and accumulated cues.

Caption text is scanned in memory for a number and discarded; nothing from the
broadcast is stored or copied. The only output is offset and rate.

### If captions aren't exposed

DRM players commonly withhold caption cues from extensions. Auto-calibrate then
falls back to **the broadcast's own start time**, which streaming sites usually
leave in page state even when they hide everything else. That pins the offset
exactly; rate is assumed 1.00×, so any ad breaks accumulate as drift later in
the recording. The fix is one manual anchor near the finish — offset comes from
the metadata, rate from your single anchor.

Candidate timestamps are sanity-checked before use: one must sit *before* the
racing we have data for, by no more than a few hours, and the whole race has to
fit inside the recording. An unrelated timestamp elsewhere in page state is
rejected rather than silently believed.

### If neither works: Diagnose

Click **Diagnose**. It reports what this player actually exposes — video
timing, `getStartDate()`, app-state objects, inline JSON, `data-*` attributes —
ranks any timestamps that could serve as a clock, copies the report to your
clipboard and logs it to the console. Share it and the calibration can be built
against what is really there rather than guessed at.

It reads metadata only: element properties, timing ranges and state objects the
page already created. No frames are read and no stream content is touched.

## The profile is always on screen

The profile never disappears, because it does not depend on calibration: km and
altitude are intrinsic to the scraped route. The bar switches axis instead.

| | x-axis | needs | clicking to seek |
|---|---|---|---|
| **Calibrated** | recording time | a calibration + a loaded video | seeks |
| **Otherwise** | route distance, km 0 → finish | nothing | declined |

Distance mode carries km ticks, so the shape always has scale. Guideposts are
placed on it too — route
ones by their own km, ticker ones by interpolating the time-synced profile.
Seeking is *declined* rather than approximated while uncalibrated: a
plausible-looking wrong seek is worse than none.

Hovering anywhere on the bar reads out
`77.8 km to go · 677m · 13:34Z · rec 2:14:07`, so the scraped numbers behind
the shape are one mouse-move away.

**Distance is always km remaining to the line**, never km travelled — that is
how a race is called and how the riders' own numbers run. It comes from the
profile's `kmto` column rather than `stage_length - km`: stages.json says 155.5
for stage 14 where the route file says 155.2, and adopting that 0.3 km would
reintroduce the constant offset the sync exists to remove. The x axis still
runs start → finish left to right, so the shape matches a published profile
while every label counts down (`116km to go`, `78km to go`, `39km to go`).

Collapsing (**–**) hides the controls but keeps the profile as a slim strip.
The controls are only how it gets calibrated; the profile is the thing you read.

**The bar states which axis it is on.** Time mode says `time · aligned to
recording`; before calibration it carries an amber prompt to set km 0 and draws
no playhead. An uncalibrated bar looks identical to a calibrated one, so reading
distance as time is the most misleading failure available here — the shape is
right and the position means nothing.

### Imputed stretches

On the time axis the bar covers the whole *recording*, which is longer than the
race: build-up before km 0, coverage after the line. Nobody is riding then, so
no elevation exists. Rather than leave those ends blank and break the trace into
fragments, they are held flat at the start and finish altitudes and drawn faint
and dashed. Gaps inside the race are bridged linearly the same way.

Three weights, three different claims:

| | meaning |
|---|---|
| solid | GPS-observed |
| dashed, dimmer | estimated — GPS was offline, pace inferred from the known start |
| faint, fine dashes | imputed — no race happening at that point in the recording |

Tests (need Playwright):

    python tests/test_extension_profile.py      # profile always drawn, full span
    python tests/test_extension_calibration.py  # alignment against real numbers

## Making the elevation line up exactly

If the km-0 pin is a little off, **Align** nudges it against the picture
rather than by arithmetic:

| Action | Effect |
|---|---|
| Drag the bar | Shifts the whole profile (offset) |
| ← / → | Nudge 1 second |
| ↑ / ↓ | Nudge 10 seconds |

Everything updates live, so you judge alignment against what's on screen rather
than trusting a number. Click **Done** to leave align mode; the calibration is
saved per stage, so km 0 is a once-per-stage step.

### The profile spans the whole stage

GPS often comes online partway through a stage — stage 14's first fix is 31 km
in, a fifth of the route. Rather than truncate that off the bar, the head is
spanned using the stage's *actual* start time, which the ticker marks
(`liv_actual_start`). Stage 14 rolled at 11:35:38 UTC, 5m38s later than the
published schedule, so the ticker's marker matters.

That stretch is drawn **dashed and dimmer**: the whole stage is visible, but
inferred pacing is not presented as the same claim as observed GPS. Only the
average speed across the gap is known, not how it varied.

| Stage | Route drawn | Observed | Estimated |
|---|---|---|---|
| 14 | km 0.0 → 155.1 of 155.2 | 494 pts | 311 pts (dashed head) |
| 15 | km 0.1 → 183.7 of 183.8 | 1,805 pts | none — GPS covered it all |

### Why it was off before

Two real errors, both now fixed:

* The time mapping converted GPS `kmToFinish` into distance-covered using the
  stage length from `stages.json` — 155.5 km for stage 14, where the route file
  says 155.2. That 0.3 km is a **systematic ~27 second error** at racing speed.
  The profile ships its own `kmto` column, so matching km-to-finish directly
  removes the constant and the error with it.
* Only one GPS capture was read. Merging every capture for a stage raised
  stage 15 from 1,711 to 1,805 time-observed route points, which tightens the
  interpolation between them.

## Reading the bar

| Element | Meaning |
|---|---|
| Blue silhouette | Elevation, positioned at the time the **leader** reached it |
| Coloured ticks | Guideposts — click any to seek there; hover for the label |
| Red strip (bottom) | Race intensity: ticker density + road gradient |
| White line | Current playback position |
| Right-hand labels | Highest / lowest elevation on the stage |

Checkboxes filter categories, so you can navigate by only what you care about
— e.g. scenery and summits, with attacks and stats off.

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

- **Not tested against the live player.** The logic is verified end-to-end in a
  headless browser against a synthetic `<video>` (profile rendering, two-point
  calibration, marker seeking). Peacock's DOM is not an API; if the panel
  doesn't appear, the video-element lookup in `findVideo()` is the place to
  look. The panel floats over the page rather than injecting into the player's
  own controls, specifically so their markup changes can't break it.
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
