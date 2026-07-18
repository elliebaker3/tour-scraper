"""Discover endpoints from a browser HAR export.

Some feeds (the detailed time-stamped event/commentary stream, possibly the
radio player's stream URL) may not be guessable in advance. The reliable way
to find them:

  1. Open https://racecenter.letour.fr/en/ in Chrome during a live stage
  2. DevTools -> Network tab -> let it run a minute or two
  3. Right-click any request -> "Save all as HAR with content"
  4. python -m tourscraper har path/to/capture.har

This prints candidate data endpoints (JSON/SSE/audio), grouped and ranked, and
suggests config.yaml entries. It also saves the full inventory to
data/{year}/reference/har-endpoints.json for later inspection.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from .config import Config
from .storage import save_reference

INTERESTING_TYPES = ("json", "event-stream", "audio", "mpegurl", "csv", "xml")
BORING = re.compile(r"\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico|webp)(\?|$)", re.I)


def analyze_har(cfg: Config, har_path: str) -> None:
    har = json.loads(Path(har_path).read_text(encoding="utf-8"))
    entries = har.get("log", {}).get("entries", [])
    by_kind: dict[str, list[dict]] = defaultdict(list)

    for entry in entries:
        request = entry.get("request", {})
        response = entry.get("response", {})
        url = request.get("url", "")
        if BORING.search(url):
            continue
        mime = (response.get("content", {}) or {}).get("mimeType", "") or ""
        kind = next((t for t in INTERESTING_TYPES if t in mime), None)
        if not kind and "/api/" in url:
            kind = "api-path"
        if not kind:
            continue
        sample = (response.get("content", {}) or {}).get("text", "") or ""
        by_kind[kind].append({
            "url": url,
            "method": request.get("method"),
            "status": response.get("status"),
            "mime": mime,
            "size": (response.get("content", {}) or {}).get("size"),
            "sample": sample[:400],
        })

    inventory = {k: v for k, v in by_kind.items()}
    path = save_reference(cfg.year_dir, "har-endpoints", inventory)
    print(f"[har] full inventory saved -> {path}\n")

    for kind, items in sorted(inventory.items()):
        print(f"== {kind} ({len(items)} requests) ==")
        seen = set()
        for item in items:
            base = item["url"].split("?")[0]
            if base in seen:
                continue
            seen.add(base)
            print(f"  {item['method']} {item['status']} {item['url'][:140]}")
        print()

    print("Next: pick the endpoint(s) that carry commentary/event items and add "
          "them to config/config.yaml under poll_endpoints, e.g.\n"
          "  poll_endpoints:\n"
          "    commentary: \"https://racecenter.letour.fr/api/...\"\n"
          "Audio/mpegurl entries are candidates for radio_stream_url.")
