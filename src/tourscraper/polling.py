"""Fallback pollers + radio recorder.

1) poll_endpoints: if the live commentary feed (or anything else) turns out to
   live at a plain JSON endpoint rather than on the SSE stream, add it to
   config.yaml under poll_endpoints and this module snapshots it on an interval,
   writing only changed responses (hash-deduped) to polls/{name}.jsonl.

2) radio: records a live audio stream URL with ffmpeg into hourly-chunked
   files, so a dropped connection loses at most one chunk.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import time
from datetime import datetime, timezone

from .config import Config
from .storage import StageStore, utcnow
from .static_api import get_with_retry, make_session


def poll_loop(cfg: Config, store: StageStore, stop_after_seconds: int | None = None) -> None:
    if not cfg.poll_endpoints:
        print("[poll] no poll_endpoints configured; skipping")
        return
    session = make_session(cfg)
    writers = {name: store.poll_writer(name) for name in cfg.poll_endpoints}
    last_hash: dict[str, str] = {}
    started = time.monotonic()
    store.write_manifest({"kind": "poll", "endpoints": list(cfg.poll_endpoints)})
    print(f"[poll] polling {list(cfg.poll_endpoints)} every {cfg.poll_interval_seconds}s")

    while True:
        if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
            break
        for name, endpoint in cfg.poll_endpoints.items():
            url = endpoint if endpoint.startswith("http") else cfg.url(endpoint)
            try:
                resp = get_with_retry(session, cfg, url)
                body = resp.text
                digest = hashlib.sha256(body.encode()).hexdigest()
                if last_hash.get(name) == digest:
                    continue
                last_hash[name] = digest
                writers[name].write({
                    "captured_at": utcnow(),
                    "url": url,
                    "status": resp.status_code,
                    "body": body,
                })
            except Exception as exc:
                print(f"[poll] {name} failed: {exc}")
        try:
            time.sleep(cfg.poll_interval_seconds)
        except KeyboardInterrupt:
            break
    for writer in writers.values():
        writer.close()


def record_radio(cfg: Config, store: StageStore, stop_after_seconds: int | None = None,
                 chunk_seconds: int = 3600) -> None:
    """Record cfg.radio_stream_url via ffmpeg in chunks; reconnect on failure."""
    if not cfg.radio_stream_url:
        print("[radio] radio_stream_url not set in config.yaml; skipping. "
              "Find the stream URL (see README 'Radio') and add it.")
        return
    if not shutil.which("ffmpeg"):
        print("[radio] ffmpeg not found on PATH; install it to record radio.")
        return
    store.write_manifest({"kind": "radio", "source": cfg.radio_stream_url})
    started = time.monotonic()
    while True:
        if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
            break
        remaining = None
        if stop_after_seconds:
            remaining = max(1, int(stop_after_seconds - (time.monotonic() - started)))
        duration = min(chunk_seconds, remaining) if remaining else chunk_seconds
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = store.dir / "radio" / f"radio_{stamp}.mp3"
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
            "-user_agent", cfg.user_agent,
            "-i", cfg.radio_stream_url,
            "-t", str(duration),
            "-c:a", "libmp3lame", "-b:a", "64k",
            str(out),
        ]
        print(f"[radio] recording chunk -> {out}")
        try:
            subprocess.run(cmd, check=False)
        except KeyboardInterrupt:
            break
        time.sleep(2)
    print("[radio] stopped")
