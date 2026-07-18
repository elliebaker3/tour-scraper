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


def parse_publication(stage_dir: Path) -> list[dict]:
    """Return all events from the newest snapshot, oldest first."""
    src = stage_dir / "polls" / "publication.jsonl"
    if not src.exists():
        raise FileNotFoundError(f"no publication capture at {src}")
    last = None
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                last = json.loads(line)
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
