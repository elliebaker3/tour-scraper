# tour-scraper

Data collection layer for the **Tour Tools** project — specifically feeding the
**Tour Navigator**, the recording-navigation-bar tool whose guideposts come from
non-video data sources. This repo scrapes those sources as they happen live and
deposits them, organized per stage, into `data/`.

## The four data sources and where they land

| # | Source | How it's captured | Lands in |
|---|--------|-------------------|----------|
| 1 | Time-stamped detailed event feed | SSE `/live-stream` binds that look like commentary items, auto-deduped; if it turns out to be a plain JSON endpoint, the `poll` fallback captures it | `events.jsonl`, `polls/*.jsonl` |
| 2 | Per-second speed + distance-to-finish for every rider | SSE `telemetryCompetitor-{year}` (per-rider GPS/speed snapshots) and `pack-{year}` (groups, gaps, remaining distance) | `telemetry.jsonl`, `groups.jsonl` |
| 3 | Live radio feed | `ffmpeg` stream recorder, hourly chunks | `radio/*.mp3` |
| 4 | Elevation profile of each stage | Route-point CSVs at `/profils/{year}/profile-NN-<hash>.csv`, auto-discovered from the stage API and page bundles | `profile.csv` |

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

## Quick start (run this before Saturday)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

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

## Discovering endpoints that can't be guessed (event feed, radio URL)

The detailed commentary feed and the radio stream URL are best captured from a
real browser session during a live stage:

1. Open https://racecenter.letour.fr/en/ during Saturday's stage, start the
   radio player, let the page run ~2 minutes.
2. DevTools → Network → right-click → **Save all as HAR with content**.
3. `python -m tourscraper har capture.har`

It prints candidate JSON/SSE/audio endpoints and saves the inventory. Paste the
commentary endpoint into `config/config.yaml` under `poll_endpoints`, and the
audio/m3u8 URL into `radio_stream_url` (or the `TOUR_RADIO_URL` repo secret for
GitHub Actions).

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

1. **GitHub Actions** (`.github/workflows/scrape-stage.yml`): push this repo to
   GitHub, edit the cron line to ~15 min before stage start (UTC), and GitHub's
   servers run the capture and commit the data back to the repo. Your machine
   can be off. Data is also uploaded as a run artifact in case the commit
   fails. Jobs cap at 6h — start close to stage start, or fire a second
   overlapping run via `workflow_dispatch` for marathon mountain days.
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

- Honest User-Agent, single SSE connection, 30s poll interval, 1s pauses
  between profile downloads — a lighter footprint than one open browser tab.
- This is publicly displayed data archived for a personal project. Note that
  letour.fr's terms may restrict automated access and reuse; keep this archive
  personal, don't redistribute the data or audio, and if you ever want to ship
  Tour Tools publicly, that's the point to look into A.S.O. licensing.

## Known unknowns (read before Saturday)

- **2026 field names may differ** from the 2025-era binds. Mitigation: raw log
  + `reparse`, and `probe` before the stage.
- **The event feed's exact location** (SSE bind vs. JSON endpoint) is the main
  thing to confirm via the HAR capture on Saturday.
- **Radio stream URL** must be discovered once via HAR, then it's set-and-forget.
- Telemetry granularity is whatever the feed pushes (roughly per-second in past
  years, from GPS on bikes/motos; time trials and crashes get noisy).
