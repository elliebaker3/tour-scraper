"""Organized storage layout.

data/
  {year}/
    reference/                      # season-level, refreshed daily
      riders.json
      teams.json
      stages.json
    stage-{NN}_{YYYY-MM-DD}/        # one folder per stage
      manifest.jsonl                # what was captured, when, by what version
                                     # (manifest.part-N.jsonl per chunk; see
                                     # StageStore.write_manifest/read_manifest.
                                     # manifest.json, a single JSON array, is
                                     # the pre-chunking legacy format)
      profile.csv                   # route points: the elevation profile
      live-stream.raw.jsonl         # EVERY SSE event, verbatim + capture ts
      telemetry.jsonl               # parsed per-rider GPS/speed snapshots
      groups.jsonl                  # parsed group composition / gaps / dist-to-finish
      events.jsonl                  # race events / commentary items (deduped)
      polls/{name}.jsonl            # raw snapshots from any configured poll endpoint
      radio/                        # recorded audio chunks

All timestamps are UTC ISO-8601. JSONL = one JSON object per line, append-only,
crash-safe: a killed scraper loses at most one partial line.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class JsonlWriter:
    """Append-only JSONL writer, flushed per line, thread-safe."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(path, "a", encoding="utf-8")
        self._lock = threading.Lock()
        self.path = path

    def write(self, obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._fh.write(line + "\n")
            self._fh.flush()

    def close(self) -> None:
        with self._lock:
            self._fh.close()


class StageStore:
    """Paths and writers for one stage's capture session."""

    def __init__(self, year_dir: Path, stage_number: int | str, date: str | None = None,
                 part: str | None = None):
        """`part` keeps concurrent capture sessions off each other's files.

        The stage capture is run as several chained jobs, each committing to
        the same repo. When they all append to one telemetry.jsonl, the git
        merge between them decides which copy survives -- and on stage 20 the
        shorter one won, destroying 2.5 hours of GPS. Naming each session's
        output separately removes the question: no two writers ever touch the
        same path, so there is no merge to get wrong. The bundle builder takes
        several telemetry files already.
        """
        date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.part = str(part) if part not in (None, "") else None
        try:
            label = f"stage-{int(stage_number):02d}_{date}"
        except (TypeError, ValueError):
            label = f"stage-{stage_number}_{date}"
        self.dir = year_dir / label
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "radio").mkdir(exist_ok=True)
        (self.dir / "polls").mkdir(exist_ok=True)

    def _partname(self, name: str) -> str:
        if not self.part:
            return name
        stem, dot, ext = name.partition(".")
        return f"{stem}.part-{self.part}{dot}{ext}"

    def writer(self, name: str) -> JsonlWriter:
        return JsonlWriter(self.dir / self._partname(name))

    def poll_writer(self, name: str) -> JsonlWriter:
        return JsonlWriter(self.dir / "polls" / self._partname(f"{name}.jsonl"))

    def write_manifest(self, entry: dict) -> None:
        """One manifest event, appended as its own JSONL line rather than a
        single manifest.json array read back and rewritten whole.

        A chunked capture calls this many times across several chained CI
        jobs, each starting from whatever the previous chunk last pushed --
        exactly the collision this class's own docstring already describes
        for telemetry.jsonl, except worse: two chunks each appending one
        entry to the SAME json array is an "add/add" conflict git cannot
        3-way-merge at all (not just a garbled file to pick a winner from).
        Confirmed as the actual cause of stage 8's chunks 2 and 3
        (2026-08-29) silently failing to push anything for ~2 hours each:
        their very first incremental commit already conflicted on
        manifest.json, and every retry after that just replayed the same
        conflict. See read_manifest() for reading these back.
        """
        path = self.dir / self._partname("manifest.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"recorded_at": utcnow(), **entry}, ensure_ascii=False) + "\n")


def read_manifest(stage_dir: Path) -> list[dict]:
    """Every manifest entry for a stage: legacy manifest.json (one JSON
    array, from before write_manifest moved to per-chunk JSONL) plus every
    manifest*.jsonl (one object per line, one file per chunk/part). Order
    across files isn't guaranteed -- sort by recorded_at if it matters."""
    entries: list[dict] = []
    legacy = stage_dir / "manifest.json"
    if legacy.exists():
        try:
            entries.extend(json.loads(legacy.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    for path in sorted(stage_dir.glob("manifest*.jsonl")):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    return entries


def save_reference(year_dir: Path, name: str, payload) -> Path:
    ref = year_dir / "reference"
    ref.mkdir(parents=True, exist_ok=True)
    path = ref / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return path


def stage_date(year_dir: Path, stage: int) -> str | None:
    """A stage's official date (YYYY-MM-DD) from bootstrap's own
    reference/stages.json, or None if it isn't there.

    Exists because StageStore falls back to *today's* date when none is
    given, which is only correct for a capture actually run live, during
    that stage. archive_stage()/backfill_stage() run after the fact --
    sometimes hours or days after, once GitHub's scheduler catches up (or a
    stage that never triggered live at all gets salvaged by hand) -- and
    defaulting to "today" there scattered a single stage's data across
    multiple wrongly-dated folders more than once before this existed.
    """
    path = year_dir / "reference" / "stages.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    for s in data:
        if s.get("stage") == stage:
            date = s.get("date")
            return str(date)[:10] if date else None
    return None
