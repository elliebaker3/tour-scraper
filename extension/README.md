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

## Calibrate automatically (try this first)

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

If auto-calibration reports no cues, the player isn't exposing captions to
extensions — use the manual method below.

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

## Swapping stages

The panel loads `data/stage.json`. Regenerate it from the repo root:

```bash
python -m tourscraper navigator --stage 15 \
  --stage-dir data/2026/stage-15_2026-07-19 \
  --telemetry ~/tour-archive/2026/stage-15_2026-07-19/polls/telemetry.jsonl
cp data/2026/stage-15_2026-07-19/navigator.json extension/data/stage.json
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
