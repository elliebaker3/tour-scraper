# tour-scraper

Data collection layer for the **Tour Tools** project — specifically feeding the
**Tour Navigator**, the recording-navigation-bar tool whose guideposts come from
non-video data sources. This repo scrapes those sources as they happen live and
deposits them, organized per stage, into `data/`.

## The five data sources and where they land

| # | Source | How it's captured | Lands in |
|---|--------|-------------------|----------|
| 1 | Time-stamped detailed event feed | Confirmed real 2026 endpoint: `poll_endpoints.flashInfoLive` = `/api/flashInfoLive-{year}-{stage}`. Also written raw from SSE `/live-stream` if it turns out to double up there | `polls/flashInfoLive.jsonl`, `events.jsonl` |
| 2 | Per-second speed + distance-to-finish for every rider | SSE `telemetryCompetitor-{year}` / `pack-{year}` (per-rider GPS/speed, groups/gaps/remaining distance), cross-checked against the confirmed `checkpointList-{year}-{stage}` poll endpoint, which keys checkpoint passes the same way (`cpnumero`) as the elevation profile CSV — this is the join that lets the Navigator place the leader on the profile | `telemetry.jsonl`, `groups.jsonl`, `polls/checkpointList.jsonl` |
| 3 | Live radio feed | `ffmpeg`, one persistent connection for the whole session, segmented into hourly files on the *output* side (`-f segment`) so nothing is dropped at hour boundaries. URL still needs discovery — see `autodiscover` below | `radio/*.mp3` |
| 4 | Elevation profile of each stage | The old static-HTML/JS-bundle regex scan (`fetch_profiles`) no longer finds it — 2026 loads it dynamically with an unpredictable content hash in the filename. `autodiscover` (headless browser) finds and downloads it automatically instead | `profile.csv` |
| 5 | Reference elevation profile, **every** stage | velowire.com's season KMZ — their Google Earth export, one traced route per stage with per-vertex altitude plus climb/sprint/finish waypoints. `python -m tourscraper velowire-profiles` downloads it once, converts each stage to distance/elevation JSON (rescaled to the official stage length; the raw trace runs a few % long), and publishes "profile-only" bundles to the extension for every stage without a live capture. This is the coverage floor: source 4 only exists for stages the scraper ran during, this one exists for all 21. Uses only the KMZ, which velowire distributes for exactly this kind of import — never their profile images | `profiles/velowire/stage-NN.json`, `extension/data/profile-stage-NN.json` |

Everything on the SSE stream is *also* written verbatim to
`live-stream.raw.jsonl` before any parsing. If A.S.O. changed a field name for
2026, you lose nothing on capture day — fix the parser later and run
`reparse`.

## La Vuelta a España

Confirmed 2026-08-22 (stage 1 day): `racecenter.lavuelta.es` is the **same
racecenter platform** as the Tour's `racecenter.letour.fr` -- identical
endpoint paths, identical JSON shapes, identical SSE bind-name convention,
even the same `img.aso.fr` asset CDN in the riders/teams payloads. So rather
than a separate scraper, the Vuelta is just this repo's existing pipeline
pointed at a different `base_url`, with everything written under a separate
`data/vuelta/` tree (`config/config-vuelta.yaml`'s `data_dir`) so a capture
can never collide with a Tour one in `data/2026`:

```bash
python -m tourscraper --config config/config-vuelta.yaml probe        # confirm the endpoints still match
python -m tourscraper --config config/config-vuelta.yaml bootstrap    # riders/teams/stages -> data/vuelta/2026/reference/
python -m tourscraper --config config/config-vuelta.yaml autodiscover # radio URL + profile CSV, same as the Tour
python -m tourscraper --config config/config-vuelta.yaml stage --stage 14 --max-hours 6
```

Every other command (`live`, `poll`, `radio`, `har`, `reparse`, `archive`,
`navigator`, `backfill`...) takes the same `--config` flag. GitHub Actions
parity is `scrape-stage-vuelta.yml` (all 21 stages' discover/scrape crons,
computed from each stage's real `startTime`/`endTime` in
`data/vuelta/2026/reference/stages.json`) alongside the Tour's
`scrape-stage.yml`; both call the same shared `scrape-chunk.yml`, now taking
an optional `config:` input.

One real difference so far: **stage 1 (2026-08-22, Monaco) is an individual
time trial** (`"type": "itt"` in stages.json) -- nothing like it appears on
the Tour side of this repo. Two extra sources cover it:

- `config-vuelta.yaml` polls `rankingType-{year}-{stage}`, carrying per-bib
  `{position, absolute, relative}` at each checkpoint the field has reached
  (confirmed live: entries carry a `checkpoint` number that advances as the
  stage runs) -- the same "record everything raw" poll pattern as every
  other endpoint here.
- **Per-rider departure time has no JSON endpoint at all** -- confirmed by
  capturing every network response (JSON and otherwise) a real page load
  makes. The racecenter page renders it anyway: a `q-table` with one row per
  rider (start order, name, bib, team, departure time, intermediate-point
  split, arrival split), computed client-side as
  `stage.startTime + (start_order - 1) x 60s` -- `start_order` itself isn't
  in `allCompetitors-{year}` either, so the rendered table is the only place
  this exists. `startlist_scrape.py` reads it with a real headless browser
  (Playwright, already a dependency) rather than reverse-engineering the
  client-side computation:

  ```bash
  python -m tourscraper --config config/config-vuelta.yaml startlist --stage 1
  ```

  Snapshots the full table every `--interval-seconds` (default 120) into
  `<stage-dir>/startlist.jsonl` -- one line per snapshot, since intermediate/
  arrival cells fill in live as the stage runs and a single scrape only ever
  sees whatever had finished by that moment. Not wired into `stage`'s three
  concurrent threads (live/poll/radio): unlike those, this needs a browser,
  so it's a separate process run alongside it for stages that need it.

**Radio has no static shortcut here.** The Tour's `radio_stream_url` comes
from `/api/event`'s `extras.radioUrl`; the Vuelta's `/api/event` carried no
such field as of 2026-08-22, and `autodiscover` found no confident candidate
either. `radio_stream_url` stays blank in `config-vuelta.yaml` until one
turns up -- everything else works unaffected (`record_radio` no-ops with
nothing configured).

**Event classification and persons-of-interest tagging work unchanged.**
`extract_events.py` (crash/breakaway/scenic/history classification + the
intensity curve) and `events_parse.py` read only captured
`polls/publication.jsonl` -- no host baked in -- so they needed nothing.
Verified against real stage 1 commentary: 70 ticker items parsed, correctly
classified (15 history, 2 stat, 2 crash -- the crash hits are pre-race
biographical text mentioning a rider's past crashes, the same class of false
positive this classifier already produces on the Tour's side, not a Vuelta-
specific issue). Zero breakaway events, correctly, since stage 1 is an ITT --
there's no group to attack out of or get caught by.

`persons_of_interest.py` (GC/points/young-rider contenders, and the
POI x event tags on crash/breakaway markers) DID have the Tour's URLs
hardcoded -- `racecenter.letour.fr` for the GC standings,
`www.letour.fr/en/rankings/stage-N` for the points classification page. Both
now come from `cfg.base_url`/`cfg.site_base_url` (`build()`,
`fetch_gc_order()`, `fetch_points_slugs()` all take them as parameters,
defaulting to the Tour's own values so nothing about the Tour's behaviour
changed). Confirmed live against the Vuelta: `rankingTypeArrival-2026-1`
carries the same `itg` (GC) type code, and `lavuelta.es/en/rankings/stage-1`
embeds the same `data-ajax-stack` (`ipg` = points) the parser already reads.
Fetching persons-of-interest for stage 2 (standings after stage 1) returned
real data -- Pogačar leading GC, both the points and young-rider lists
populated. The `yellow`/`green`/`white` field names are jersey ROLES carried
over from the Tour's implementation, not literal colours -- the Vuelta's
leader jersey is red, but the role is still "GC leader" underneath (see
`JERSEY_NAME` for the human-readable label); left alone since nothing
currently renders the raw key as a colour.

`backfill.py`'s ProCyclingStats slug (`race/tour-de-france`) and its
official-site stage-review fetch (`letour.fr/en/stage-N`) were also
hardcoded; now `cfg.pcs_race_slug` and `cfg.site_base_url`
(`config-vuelta.yaml` sets `pcs_race_slug: "race/vuelta-a-espana"`, PCS's
standard slug convention, though NOT independently confirmed live -- PCS
403'd every request during this session's testing, including the Tour's own
already-working slug with a full browser UA, which looks like a general
bot-block rather than anything specific to this value). The saved directory
is `backfill/official/` now (was `backfill/letour/`) since it's no longer
Tour-specific.

**Elevation/route also has its own, separate source here** (not source 5's
velowire KMZ, which is Tour-only): lavuelta.es embeds one komoot.com tour per
stage (`<iframe data-src="…komoot.com/tour/<id>/embed?share_token=…">`,
lazy-loaded so it sits in the page's raw HTML unchanged, no headless browser
needed). komoot's own API serves the full route behind that id+token with no
further auth -- a dense real-survey trace with elevation on every point, same
shape as the Tour's GPX source (`gpx_profile.py`), just with no climb/sprint
names.

```bash
python -m tourscraper vuelta-komoot-profiles
```

Scrapes all 21 `lavuelta.es/en/stage-N` pages for their komoot tour id +
share token (cached to `reference/komoot-tours.json`; pass `--refresh` to
re-scrape), downloads each route, and writes:

```
data/vuelta/2026/
  gpx/stage-N.gpx                  full-resolution track, GPX 1.1
  profiles/komoot/stage-NN.json    {profile: [{km, alt}], raw_km, length_km,
                                    scale, elevation_up_m, elevation_down_m}
  reference/komoot-tours.json      stage -> {tour_id, share_token, url}
  reference/komoot-stages.json     stage -> {name, length_km, elevation_up_m/down_m}
```

Deliberately NOT `reference/stages.json` -- that filename means `bootstrap`'s
own output (ASO's authoritative stage metadata) everywhere else in this repo,
Tour or Vuelta, and the two pipelines would otherwise silently overwrite each
other's file there.

`length_km` is rescaled from komoot's own reported distance, same rule as
`gpx_profile.profile_from_track` — flagged via `note` rather than silently
squeezed if a stage's traced route disagrees with it by more than 5 km.

### Crowdsourced calibration, race-scoped

The Tour and the Vuelta both run 21 stages in 2026, so "stage 14" alone isn't
a unique key once two races share a year -- see `extension/navigator.js`'s
`stageKey()`/`raceStageKey()` and `worker/src/index.js`'s `KNOWN_RACES`. A
Vuelta bundle is tagged `race: "vuelta"` in `extension/data/index.json`
(`vuelta-profile-stage-NN.json`, published by `vuelta-komoot-profiles`); a
calibration recorded against one carries `race: "vuelta"` too, both locally
(`chrome.storage.local`, key `tnCal:v1:{year}|stage-vuelta-N|{site}`) and in
the shared store (`extension/data/calibrations.json`, key
`stage-vuelta-N|{site}`). Tour calibrations are completely unaffected: no
`race` field, or `race: "tdf"`, both mean exactly what an un-prefixed
`stage-N` key has always meant, so every calibration recorded before this
existed -- local or in the already-published shared store -- keeps resolving
exactly as it did.

## Data layout

```
data/2026/
  reference/                       riders.json, teams.json, stages.json,
                                   har-endpoints.json
  profiles/                        all discovered profile CSVs
  stage-14_2026-07-18/
    manifest.json                  capture log: what ran, when, event counts
    profile.csv                    elevation/route points for the stage
    live-stream.raw.jsonl          every SSE event, timestamped at capture
    telemetry.jsonl                per-rider {Bib, Latitude, Longitude, speed…}
    groups.jsonl                   group composition, gaps, distance to finish
    events.jsonl                   race events / commentary items
    polls/<name>.jsonl             snapshots of any configured poll endpoint
    radio/radio_<ts>.mp3           audio chunks
```

`captured_at` (UTC, wall-clock at your scraper) appears on every record, so you
can later align race data with your stage *recording's* timeline — the core
join the Navigator needs.

## Quick start

Needs Python 3.10+ — if your default `python3` resolves to something older (e.g.
a conda `base` env), point the venv at a newer interpreter explicitly
(`python3.12 -m venv .venv`, adjusting the path/version for your machine).

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install --upgrade pip
pip install -e .            # NOT just `pip install -r requirements.txt` — that
                             # installs the dependencies but not the tourscraper
                             # package itself, so `python -m tourscraper` won't
                             # find it.

python -m tourscraper probe        # do the endpoints answer? what shape?
python -m tourscraper bootstrap    # riders / teams / stages -> data/2026/reference/
python -m tourscraper profiles     # elevation-profile CSVs
```

`probe` is the important one: it tells you immediately whether the 2026 site
still uses the 2025-era endpoints this repo was built against, before any stage
is on the line.

## During a stage

```bash
python -m tourscraper stage --stage 14 --max-hours 6
```

runs all three recorders concurrently (SSE + pollers + radio) with a hard stop.
Or run them individually: `live`, `poll`, `radio` — same flags.

## Discovering endpoints that can't be guessed (radio URL, profile CSV) — automatically

```bash
python -m tourscraper autodiscover
```

This is the same idea as the manual HAR-capture workflow below, but it drives
a **headless Chromium** (Playwright) instead of asking you to open DevTools —
so it can run unattended in CI with nobody at a keyboard. It:

- loads racecenter.letour.fr for real, so anything only reachable by running
  the site's own JS (like the elevation-profile CSV's hashed filename) gets
  captured
- watches every HTTP response *and* individual SSE frames (via the Chrome
  DevTools Protocol) for ~2.5 minutes
- downloads any elevation-profile CSVs it sees, straight into `data/{year}/profiles/`
  and the matching stage folder
- patches `config/config.yaml` with `radio_stream_url` / `poll_endpoints`
  when it finds exactly one confident candidate; ambiguous finds are left for
  you to pick from `data/{year}/reference/autodiscover-endpoints.json`

The GitHub Actions workflow runs this automatically in a `discover` job ~2.5
hours before each stage (see below) — no manual step needed. The one thing it
still can't fully guarantee: the radio stream sometimes only starts once the
broadcast is actually live, so run it again closer to air time if the first
pass doesn't find `radio_stream_url`.

### Manual fallback (HAR capture)

If `autodiscover` comes up empty on something, the manual path still works:

1. Open https://racecenter.letour.fr/en/ during a live stage, start the radio
   player, let the page run ~2 minutes.
2. DevTools → Network → right-click → **Save all as HAR with content**.
3. `python -m tourscraper har capture.har`

It prints candidate JSON/SSE/audio endpoints and saves the inventory. Paste the
commentary endpoint into `config/config.yaml` under `poll_endpoints`, and the
audio/m3u8 URL into `radio_stream_url`.

## Backfilling stages that already happened

PCS keeps its LiveStats timeline archived after each stage, with items keyed
by **km to the finish** — which maps straight onto the elevation profile for
the Navigator. To pull stages 1-12:

```bash
python -m tourscraper backfill --stages 1-12
```

Per stage this archives (raw HTML under `backfill/pcs/`) the livestats
timeline, race-events, breakaway-gap evolution, virtual GC, during-race
weather, and the result page, plus the organiser's own stage page (letour.fr
for the Tour, lavuelta.es for the Vuelta -- see `site_base_url`) under
`backfill/official/`, and parses the timelines into `events.pcs.jsonl` with
markers classified per PCS's legend (P=preview, 27m=27 min to start,
-3.2=neutralized zone, 171=171 km to finish, F=post-finish).

The parser is heuristic (built without access to the live DOM): raw HTML is
always saved first, and `python -m tourscraper backfill-reparse <stage-dir>`
rebuilds `events.pcs.jsonl` from disk after you improve `parse_timeline()` —
no refetching. It fetches ~7 pages per stage at one page per 4 s. PCS is a
small ad-supported site: keep this to one-off backfills and keep the archive
personal (their PRO subscription exists if you lean on the site). Note the
2026 route has already changed mid-Tour (stage 9 was shortened for a
heatwave), so per-stage archived pages beat pre-Tour route files.

## Running while you're not at your computer

Three options, most-hands-off first:

1. **GitHub Actions** (`.github/workflows/scrape-stage.yml`, recommended — this
   is the truly zero-touch path): two scheduled jobs, both need their cron
   times recomputed for each stage's actual start/finish (in
   `data/2026/reference/stages.json` once you've run `bootstrap`):
   - `discover` fires ~2.5h before race start, runs `autodiscover` (headless
     browser, no manual step), and commits whatever it finds back to `main`.
   - `scrape` fires ~50min before race start, auto-detects the day's stage
     number from `stages.json` (no hardcoded stage number to remember to
     update), and runs the actual capture.
   Your machine can be off the entire time. Data is also uploaded as a run
   artifact in case the commit fails. Jobs cap at 6h — that's why `scrape`
   starts close to the actual race start rather than hours early; fire a
   second overlapping run via `workflow_dispatch` for marathon mountain days.
2. **A tiny always-on box** (Raspberry Pi, $5 VPS): `scripts/install_systemd.sh`
   installs a user-level systemd timer.
3. **Your own machine on a schedule**: `scripts/com.tourtools.scraper.plist`
   (macOS launchd — keep the Mac awake with `caffeinate` or
   `pmset repeat wake`) or `scripts/crontab.example` (Linux).

Radio audio is `.gitignore`d by default because it bloats a git repo fast
(~30 MB/hour at 64 kbps). If you want it in the repo, set up Git LFS
(`git lfs track "data/**/radio/*.mp3"`) and remove the ignore line; otherwise
grab it from the Actions artifacts.

## How the endpoints were found

Built against the racecenter architecture as reverse-engineered by the
community ([mullummer/racecenter](https://github.com/mullummer/racecenter)):
static JSON at `/api/allCompetitors-{year}`, `/api/stage-{year}`,
`/api/team-{year}`; an `EventSource` SSE feed at `/live-stream` carrying
`pack-{year}` and `telemetryCompetitor-{year}` binds; profile CSVs under
`/profils/{year}/`. All of it is config-overridable because A.S.O. tweaks
things year to year — `probe` + `har` are your recovery tools when they do.

## Ground rules baked in

- Honest User-Agent, single SSE connection, 15s poll interval, 1s pauses
  between profile downloads — a lighter footprint than one open browser tab.
- This is publicly displayed data archived for a personal project. Note that
  letour.fr's terms may restrict automated access and reuse; keep this archive
  personal, don't redistribute the data or audio, and if you ever want to ship
  Tour Tools publicly, that's the point to look into A.S.O. licensing.
- This repo's data feeds the Tour Navigator browser extension, which in turn
  collects a little of its own — crowdsourced calibration readings (public)
  and passive session/viewing-pattern telemetry (private). See
  [`PRIVACY.md`](PRIVACY.md) for exactly what and why.

## Known unknowns

- **2026 field names may differ** from the 2025-era binds. Mitigation: raw log
  + `reparse`, and `probe` before the stage.
- **Radio stream URL**: `autodiscover` tries to find it automatically but the
  audio stream may only start once the broadcast is actually live — if it
  comes up empty, re-run `autodiscover` closer to air time, or fall back to
  the manual HAR capture.
- **The `/live-stream` SSE connection carries a signed `xdt=` query token**
  when opened by a real browser (a short-lived JWT-like value, issued at page
  load). This scraper's plain `requests` connection doesn't send one, but got
  an identical HTTP 200 + `text/event-stream` response during testing — so
  it's most likely optional (analytics/session-correlation) rather than
  required auth. Unconfirmed until verified against a real live stage; if
  `record_live()` connects but no `telemetryCompetitor`/`pack` binds ever
  arrive during an actual stage, this token is the first thing to suspect.
- **The elevation profile CSV update (correcting an earlier note in this
  file):** it is *not* gone. `/api/stage-2026` genuinely has no profile field,
  and the JS bundle has zero static `/profils/`/`.csv` references — but a real
  browser session shows the site still fetches
  `/profils/{year}/profile-{stage}-<hash>.csv` (plus a `-tiny-` variant), just
  with a content hash that isn't derivable from any static text, only from
  actually running the page's JS. `autodiscover` handles this correctly by
  browsing for real and downloading whatever it observes.
- Telemetry granularity is whatever the feed pushes (roughly per-second in past
  years, from GPS on bikes/motos; time trials and crashes get noisy).
- **Radio has no rewind.** ffmpeg keeps one connection open all session and
  `-reconnect` covers brief network blips, but if the stream is unreachable
  longer than `reconnect_delay_max` (10s) the outer loop restarts ffmpeg and
  that stretch of live audio is genuinely gone — there's no source to recover
  it from after the fact.
