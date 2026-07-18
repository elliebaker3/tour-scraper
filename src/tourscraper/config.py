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
    return cfg
