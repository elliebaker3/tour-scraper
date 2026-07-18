# tour-scraper

Data collection layer for the **Tour Tools** project — specifically feeding the
**Tour Navigator**, the recording-navigation-bar tool whose guideposts come from
non-video data sources. This repo scrapes those sources as they happen live and
deposits them, organized per stage, into `data/`.

## The four data sources and where they land

| # | Source | How it's captured | Lands in |
|---|--------|-------------------|----------|
| 1 | Time-stamped detailed event feed | Confirmed real 2026 endpoint: `poll_endpoints.flashInfoLive` = `/api/flashInfoLive-{year}-{stage}`. Also written raw from SSE `/live-stream` if it turns out to double up there | `polls/flashInfoLive.jsonl`, `events.jsonl` |
| 2 | Per-second speed + distance-to-finish for every rider | SSE `telemetryCompetitor-{year}` / `pack-{year}` (per-rider GPS/speed, groups/gaps/remaining distance), cross-checked against the confirmed `checkpointList-{year}-{stage}` poll endpoint, which keys checkpoint passes the same way (`cpnumero`) as the elevation profile CSV — this is the join that lets the Navigator place the leader on the profile | `telemetry.jsonl`, `groups.jsonl`, `polls/checkpointList.jsonl` |
| 3 | Live radio feed | `ffmpeg`, one persistent connection for the whole session, segmented into hourly files on the *output* side (`-f segment`) so nothing is dropped at hour boundaries. URL still needs discovery — see `autodiscover` below | `radio/*.mp3` |
| 4 | Elevation profile of each stage | The old static-HTML/JS-bundle regex scan (`fetch_profiles`) no longer finds it — 2026 loads it dynamically with an unpredictable content hash in the filename. `autodiscover` (headless browser) finds and downloads it automatically instead | `profile.csv` |

Everything on the SSE stream is *also* written verbatim to
`live-stream.raw.jsonl` before any parsing. If A.S.O. changed a field name for
2026, you lose nothing on capture day — fix the parser later and run
`reparse`.

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
weather, and the result page, plus the official letour.fr stage page under
`backfill/letour/`, and parses the timelines into `events.pcs.jsonl` with
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
