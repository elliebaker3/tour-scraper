"""Parse captured publication-feed snapshots into a structured event list.

The raw capture (polls/publication.jsonl) stays untouched -- one snapshot of
the full cumulative feed per line. This module reads the NEWEST snapshot
(which contains every item so far, since the feed is cumulative) and produces
a clean, chronological list of events shaped for downstream processing:

    {"headline": ..., "subtext": ..., "time": "HH:MM",
     "publicationAt": ISO8601, "kind": "liv"|"twitter"|..., "picto": ...}

Notes on the source structure, confirmed against live stage 14 (2026-07-18):
  - `title` is the headline shown in the racecenter ticker
  - `text` is the longer subtext; social-embed items (type "twitter") have an
    empty text by nature -- that's the feed, not a capture gap
  - two items can share the same publication minute; `id` disambiguates
  - `picto` tags some items with a category (liv_elevation, liv_yellow_jersey...)
"""

from __future__ import annotations

import json
import re
from pathlib import Path

TAG_RE = re.compile(r"<[^>]+>")


def _clean(html_text: str) -> str:
    text = TAG_RE.sub(" ", html_text)
    return " ".join(text.split())


def _newest_snapshot(stage_dir: Path, name: str) -> dict:
    """The single freshest snapshot across every polls/{name}*.jsonl file.

    A chunked capture (scrape-chunk.yml's --part) writes polls/{name}.part-
    N.jsonl per chunk instead of one polls/{name}.jsonl -- this was silently
    unhandled before (only stage 14's un-chunked capture ever parsed
    successfully; every chunk-captured stage since, Tour or Vuelta, raised
    FileNotFoundError here). Each part is still individually cumulative (the
    feed always returns everything published so far), so the snapshot with
    the latest captured_at, across every part, is simply the most complete
    one -- whichever file it happens to be in.
    """
    paths = sorted(stage_dir.glob(f"polls/{name}*.jsonl"))
    if not paths:
        raise FileNotFoundError(f"no {name} capture under {stage_dir / 'polls'}")
    newest = None
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                rec = json.loads(line)
                if newest is None or rec.get("captured_at", "") > newest.get("captured_at", ""):
                    newest = rec
    if newest is None:
        raise FileNotFoundError(f"no usable {name} snapshot under {stage_dir / 'polls'}")
    return newest


def parse_publication(stage_dir: Path) -> list[dict]:
    """Return all events from the newest snapshot, oldest first."""
    last = _newest_snapshot(stage_dir, "publication")
    items = json.loads(last["body"])
    events = []
    seen_ids = set()
    for it in items:
        pub = it.get("publicationAt")
        if not pub:
            continue
        key = it.get("id") or json.dumps(it, sort_keys=True)[:64]
        if key in seen_ids:
            continue
        seen_ids.add(key)
        events.append({
            "headline": _clean(it.get("title") or ""),
            "subtext": _clean(" ".join(it.get("text") or [])),
            "time": pub[11:16],
            "publicationAt": pub,
            "kind": it.get("type"),
            "picto": it.get("picto"),
            "id": it.get("id"),
        })
    events.sort(key=lambda e: e["publicationAt"])
    return events


def write_events(stage_dir: Path) -> Path:
    """Parse and save events.parsed.json next to the raw capture."""
    events = parse_publication(stage_dir)
    out = stage_dir / "events.parsed.json"
    out.write_text(json.dumps(events, indent=2, ensure_ascii=False))
    print(f"[events] {len(events)} events -> {out}")
    for e in events[-5:]:
        print([e["headline"], e["subtext"][:80], e["time"]])
    return out
