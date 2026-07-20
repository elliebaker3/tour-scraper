"""Retroactively archive a stage's cumulative feeds.

Discovered 2026-07-19: racecenter keeps `publication_{lang}-{year}-{stage}`
served AFTER the stage finishes, and it is cumulative -- a single request
returns every ticker item published across the whole stage day. That means a
stage whose live capture failed (or never ran) can still have its complete
EVENT feed recovered later, which is exactly what the Tour Navigator needs.

What is and isn't recoverable this way:
  publication_en  -- FULL stage history in one shot. Recoverable.
  checkpointList  -- static per stage (schedule + landmarks). Recoverable.
  pack            -- returns CURRENT/final state only, not a time series, so
                     group-composition history is NOT recoverable after the
                     fact. It must be captured live (polls/pack.jsonl).
  telemetry       -- same: live-only.

So: run this to rescue events for past stages, but keep the live capture
healthy for anything positional.
"""

from __future__ import annotations

import json

from .config import Config
from .static_api import get_with_retry, make_session
from .storage import StageStore, utcnow

# name -> endpoint template. Only cumulative/static feeds belong here.
ARCHIVE_ENDPOINTS = {
    "publication": "/api/publication_en-{year}-{stage}",
    "checkpointList": "/api/checkpointList-{year}-{stage}",
    "pack_final": "/api/pack-{year}-{stage}",
}


def archive_stage(cfg: Config, stage: int, date: str | None = None) -> dict:
    """Fetch cumulative feeds for one stage and append them to its poll logs.

    Written in the same JSONL shape the live poller uses, so downstream tools
    read archived and live-captured data through one code path. A `source`
    field marks these as backfilled rather than captured in real time.
    """
    session = make_session(cfg)
    store = StageStore(cfg.year_dir, stage, date)
    summary = {}
    for name, template in ARCHIVE_ENDPOINTS.items():
        url = cfg.url(template, stage=stage)
        try:
            resp = get_with_retry(session, cfg, url)
            resp.raise_for_status()
            body = resp.text
            writer = store.poll_writer(name)
            writer.write({
                "captured_at": utcnow(),
                "source": "archive-backfill",
                "url": url,
                "status": resp.status_code,
                "body": body,
            })
            writer.close()
            try:
                n = len(json.loads(body))
            except Exception:
                n = "?"
            summary[name] = n
            print(f"[archive] stage {stage}: {name} -> {n} records ({len(body)} bytes)")
        except Exception as exc:
            summary[name] = f"FAILED: {exc}"
            print(f"[archive] stage {stage}: {name} FAILED {exc}")
    store.write_manifest({"kind": "archive-backfill", "stage": stage,
                          "endpoints": summary})
    return summary
