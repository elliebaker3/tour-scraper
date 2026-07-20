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

## It calibrates itself

On load the panel reads the asset's airing time from the page's playback state,
picks the matching stage bundle, and derives the offset. No clicks needed.

**The stage is chosen by airing date, not by guesswork.** Peacock URLs are
opaque asset ids, so the date in `__PLAYBACK_STATE__` is what identifies which
stage you're watching. This matters more than it sounds: stage 15 data over a
stage 14 recording lines up with nothing, and the failure is silent — every
marker is simply wrong, with no error to tell you so.

What it cannot get is **rate**. Ad breaks aren't enumerated anywhere readable
(the player's metadata cues arrive with empty bodies), so rate is assumed
1.00×, and markers drift progressively later in the recording as inserted ads
accumulate. If you notice that drift, add **one** manual anchor near the finish:
offset comes from the metadata, rate from your single click.

Strategies are tried in order, best clock first:

1. `shaka.getPresentationStartTimeAsDate()` — the stream's own wall clock, when reachable
2. `__PLAYBACK_STATE__.displayStartTime` — the asset's airing time (what works on Peacock today)
3. Caption "km to go" mentions — offset *and* rate, when captions are exposed (they aren't on Peacock)

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

## Calibrate manually (fallback, ~20 seconds)

The data is in UTC race time; the player only knows "seconds into this
recording". Those differ by an unknown offset (pre-race build-up) *and* an
unknown rate (ad breaks, a broadcast joining late). Two anchors solve both.

1. Scrub to a moment you can identify on screen. Pause there.
2. In the dropdown, choose the matching moment. Click **Anchor here**.
3. Repeat once more, far from the first (early + late is best).

**Pick from the "Precise (GPS)" group.** Those are summits, the intermediate
sprint and the finish, timed from GPS — the actual second the leader crossed
that point — and they're the easiest to spot on screen thanks to the banner.
The "Approximate (ticker)" group carries ASO's *publication* time, which lags
the on-screen moment by seconds to a minute; fine as a fallback, worse as a
reference point.

**Put your two anchors far apart.** Rate is computed by dividing by the span
between them, so a 10-second misjudgment across four hours is negligible, while
the same error across twenty minutes gets multiplied into everything the tool
extrapolates.

The readout shows `calibrated · 1.000× real time`. Anchors persist per stage,
so you only do this once. Two anchors far apart give a better rate fit than
two close together; with only one anchor it assumes real time.

Until you set anchors, guideposts stay hidden rather than being drawn in the
wrong place.

## Making the elevation line up exactly

Metadata gives a good offset but cannot give **rate** — ad breaks aren't
readable anywhere — so alignment starts close and drifts later in the
recording. Click **Align** to fix it against the picture:

| Action | Effect |
|---|---|
| Drag the bar | Shifts the whole profile (offset) |
| **Shift**-drag | Stretches it about the left edge (rate) — this is what ad drift needs |
| ← / → | Nudge 1 second |
| ↑ / ↓ | Nudge 10 seconds |

Everything updates live, so you judge alignment against what's on screen rather
than trusting a number. The reliable method: scrub to a summit, drag until the
profile's peak sits under the playhead, then jump to a summit near the *other*
end and shift-drag until that one lines up too. Two summits far apart pin
offset and rate together. Click **Done** to leave align mode; the calibration is
saved per stage.

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
