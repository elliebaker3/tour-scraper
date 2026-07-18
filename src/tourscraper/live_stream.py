"""Record the racecenter's /live-stream Server-Sent Events feed.

Design principle: RECORD EVERYTHING RAW FIRST. Every SSE event is appended
verbatim (with a capture timestamp) to live-stream.raw.jsonl. Parsing into
telemetry.jsonl / groups.jsonl / events.jsonl is best-effort on top of that.
If A.S.O. renames a field for 2026, the raw log still has the data and you can
re-parse it after the fact with `python -m tourscraper reparse <stage-dir>`.

Known message binds (2025 racecenter, via community reverse engineering):
  pack-{year}                 -> groups: [{bibs: [{bib}], remainingDistance,
                                           relative (gap), ...}]
  telemetryCompetitor-{year}  -> data: {TimeStamp, Riders: [{Bib, Latitude,
                                           Longitude, (speed fields), ...}]}
Other binds (commentary/live feed, jersey standings, weather...) may exist;
they are captured raw and, if they look like event/commentary items, also
funneled into events.jsonl.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from .config import Config
from .storage import JsonlWriter, StageStore, utcnow
from .static_api import make_session


# --------------------------------------------------------------------------
# Minimal SSE parser (avoids an extra dependency; handles data:, event:, id:)
# --------------------------------------------------------------------------
def iter_sse(resp: requests.Response):
    event = {"event": "message", "data": []}
    for raw_line in resp.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue
        line = raw_line
        if line == "":
            if event["data"]:
                yield {"event": event["event"], "data": "\n".join(event["data"])}
            event = {"event": "message", "data": []}
            continue
        if line.startswith(":"):
            continue  # comment / keepalive
        if ":" in line:
            field_name, _, value = line.partition(":")
            value = value.lstrip(" ")
        else:
            field_name, value = line, ""
        if field_name == "data":
            event["data"].append(value)
        elif field_name == "event":
            event["event"] = value


# --------------------------------------------------------------------------
# Parsers for known binds
# --------------------------------------------------------------------------
def parse_message(payload: dict, year: int, captured_at: str,
                  telemetry: JsonlWriter, groups: JsonlWriter, events: JsonlWriter,
                  seen_event_ids: set) -> str:
    bind = str(payload.get("bind", ""))
    data = payload.get("data")

    if bind.startswith(f"telemetryCompetitor-{year}") and isinstance(data, dict):
        ts = data.get("TimeStamp")
        for rider in data.get("Riders", []) or []:
            record = {"captured_at": captured_at, "feed_ts": ts}
            record.update(rider)
            telemetry.write(record)
        return "telemetry"

    if bind.startswith(f"pack-{year}") and isinstance(data, dict):
        groups.write({
            "captured_at": captured_at,
            "groups": data.get("groups"),
        })
        return "groups"

    # Heuristic: anything that looks like a feed of commentary/race events.
    if isinstance(data, (list, dict)):
        items = data if isinstance(data, list) else data.get("items") or data.get("feed")
        if isinstance(items, list) and items and isinstance(items[0], dict):
            keys = set(items[0].keys())
            if keys & {"text", "message", "comment", "label", "title", "type", "km"}:
                for item in items:
                    dedupe_key = json.dumps(item, sort_keys=True, ensure_ascii=False)
                    if dedupe_key in seen_event_ids:
                        continue
                    seen_event_ids.add(dedupe_key)
                    events.write({"captured_at": captured_at, "bind": bind, "item": item})
                return "events"
    return "raw-only"


def record_live(cfg: Config, store: StageStore, stop_after_seconds: int | None = None,
                idle_reconnect_seconds: int = 90) -> None:
    """Connect to /live-stream and record until stopped.

    Reconnects on drop with backoff. `stop_after_seconds` bounds the total
    session (used by the scheduler so a job can't run forever).
    """
    raw = store.writer("live-stream.raw.jsonl")
    telemetry = store.writer("telemetry.jsonl")
    groups = store.writer("groups.jsonl")
    events = store.writer("events.jsonl")
    seen_event_ids: set = set()
    store.write_manifest({"kind": "live-stream", "action": "start"})

    started = time.monotonic()
    url = cfg.base_url + cfg.live_stream_endpoint
    session = make_session(cfg)
    session.headers["Accept"] = "text/event-stream"
    backoff_iter = 0
    counts = {"telemetry": 0, "groups": 0, "events": 0, "raw-only": 0}

    while True:
        if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
            break
        try:
            with session.get(url, stream=True, timeout=(cfg.timeout_seconds,
                                                        idle_reconnect_seconds)) as resp:
                resp.raise_for_status()
                print(f"[live] connected to {url} at {utcnow()}")
                backoff_iter = 0
                for sse_event in iter_sse(resp):
                    captured_at = utcnow()
                    raw.write({"captured_at": captured_at, **sse_event})
                    try:
                        payload = json.loads(sse_event["data"])
                    except (json.JSONDecodeError, TypeError):
                        continue
                    kind = parse_message(payload, cfg.year, captured_at,
                                         telemetry, groups, events, seen_event_ids)
                    counts[kind] = counts.get(kind, 0) + 1
                    if sum(counts.values()) % 500 == 0:
                        print(f"[live] {utcnow()} counts={counts}")
                    if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
                        break
        except KeyboardInterrupt:
            break
        except Exception as exc:
            backoff = cfg.retry_backoff_seconds[
                min(backoff_iter, len(cfg.retry_backoff_seconds) - 1)]
            backoff_iter += 1
            print(f"[live] disconnected ({exc}); reconnecting in {backoff}s")
            time.sleep(backoff)

    store.write_manifest({"kind": "live-stream", "action": "stop", "counts": counts})
    for writer in (raw, telemetry, groups, events):
        writer.close()
    print(f"[live] stopped. counts={counts}")


def reparse(stage_dir: Path, year: int) -> None:
    """Re-run parsers over live-stream.raw.jsonl (after improving parse_message)."""
    raw_path = stage_dir / "live-stream.raw.jsonl"
    if not raw_path.exists():
        print(f"no raw log at {raw_path}")
        return
    telemetry = JsonlWriter(stage_dir / "telemetry.reparsed.jsonl")
    groups = JsonlWriter(stage_dir / "groups.reparsed.jsonl")
    events = JsonlWriter(stage_dir / "events.reparsed.jsonl")
    seen: set = set()
    n = 0
    with open(raw_path, encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
                payload = json.loads(rec.get("data", ""))
            except (json.JSONDecodeError, TypeError):
                continue
            parse_message(payload, year, rec.get("captured_at", ""),
                          telemetry, groups, events, seen)
            n += 1
    for writer in (telemetry, groups, events):
        writer.close()
    print(f"[reparse] processed {n} raw events from {raw_path}")
