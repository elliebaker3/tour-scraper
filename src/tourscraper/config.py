"""Configuration loading for tour-scraper.

Defaults are derived from the racecenter.letour.fr architecture
(reverse-engineered by the community, see mullummer/racecenter):

  static JSON:  /api/allCompetitors-{year}, /api/stage-{year}, /api/team-{year}
  live SSE:     /live-stream   (EventSource; binds like "pack-{year}",
                                "telemetryCompetitor-{year}", and possibly
                                others such as a live commentary feed)
  profiles:     /profils/{year}/profile-NN-<hash>.csv

Everything is overridable in config/config.yaml so that when A.S.O. renames
something for a new year you fix it in one place.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "config.yaml"


@dataclass
class Config:
    base_url: str = "https://racecenter.letour.fr"
    # The organiser's main public site, as opposed to the racecenter API
    # host above -- persons_of_interest.py reads the points-classification
    # page from here (racecenter doesn't expose it cleanly), and backfill.py
    # archives this site's own stage-review page. A different subdomain of
    # the same platform, not a different host to discover.
    site_base_url: str = "https://www.letour.fr"
    # procyclingstats.com's URL slug for this race, e.g. "race/vuelta-a-espana"
    # for the Vuelta -- backfill.py's other source, unrelated to the ASO
    # platform above (PCS is third-party and covers every race).
    pcs_race_slug: str = "race/tour-de-france"
    # Identifies this race in extension/data/index.json entries and shared
    # calibration keys (navigator.js's stageKey()) -- "tdf" is the pre-
    # existing, un-prefixed default every real entry before this field
    # existed already means; anything else must be a race navigator.js
    # actually knows (see its stageKey()/raceStageKey()).
    race: str = "tdf"
    year: int = 2026
    data_dir: Path = Path("data")
    user_agent: str = (
        "tour-scraper/0.1 (personal archival for a fan project; low request rate)"
    )
    # Static endpoints (formatted with year)
    competitors_endpoint: str = "/api/allCompetitors-{year}"
    stages_endpoint: str = "/api/stage-{year}"
    teams_endpoint: str = "/api/team-{year}"
    # Live SSE endpoint
    live_stream_endpoint: str = "/live-stream"
    # Optional polling endpoints (fill in after discovering with `har` command)
    poll_endpoints: dict = field(default_factory=dict)
    poll_interval_seconds: int = 30
    # Radio Tour / live radio stream URL (fill in; see README)
    radio_stream_url: str = ""
    # Requests
    timeout_seconds: int = 20
    retry_backoff_seconds: list = field(default_factory=lambda: [2, 5, 15, 30, 60])

    def url(self, endpoint_template: str, **fmt) -> str:
        return self.base_url.rstrip("/") + endpoint_template.format(year=self.year, **fmt)

    @property
    def year_dir(self) -> Path:
        return Path(self.data_dir) / str(self.year)


def load_config(path: str | os.PathLike | None = None) -> Config:
    cfg = Config()
    p = Path(path) if path else DEFAULT_CONFIG_PATH
    if p.exists():
        raw = yaml.safe_load(p.read_text()) or {}
        for key, value in raw.items():
            if hasattr(cfg, key):
                if key == "data_dir":
                    value = Path(value)
                setattr(cfg, key, value)
    # Environment overrides, handy for GitHub Actions
    if os.environ.get("TOUR_BASE_URL"):
        cfg.base_url = os.environ["TOUR_BASE_URL"]
    if os.environ.get("TOUR_YEAR"):
        cfg.year = int(os.environ["TOUR_YEAR"])
    if os.environ.get("TOUR_RADIO_URL"):
        cfg.radio_stream_url = os.environ["TOUR_RADIO_URL"]
    # When set, every path under data_dir resolves under this root instead --
    # see scrape-chunk.yml, which points it at a scratch directory OUTSIDE
    # the git checkout for the live-capture step specifically. Needed because
    # that step runs `git pull --rebase` (in its incremental-push loop) in
    # the SAME working directory a live process is continuously appending
    # to. Rebase necessarily rewrites the exact file being incrementally
    # committed on disk to replay that commit -- which silently ORPHANS the
    # live writer's open file descriptor: everything appended after that
    # point goes into a now-untracked inode that vanishes when the process
    # exits, no error anywhere. Confirmed on stage 13 (2026-09-04): the raw
    # SSE capture had 417 real position updates spread across a full hour;
    # only 31 survived to the pushed file (and the job's own uploaded
    # artifact -- so this isn't a push failure, the data was gone before
    # upload even ran). Isolating the live writer under a path git never
    # touches mid-session, and rsyncing a snapshot into the real tree right
    # before each git add, removes the hazard entirely: git only ever sees a
    # static copy, never a path a live process still has open.
    if os.environ.get("TOUR_CAPTURE_ROOT"):
        cfg.data_dir = Path(os.environ["TOUR_CAPTURE_ROOT"]) / cfg.data_dir
    return cfg
