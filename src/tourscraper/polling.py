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


def poll_loop(cfg: Config, store: StageStore, stop_after_seconds: int | None = None,
              stage: str | int | None = None) -> None:
    if not cfg.poll_endpoints:
        print("[poll] no poll_endpoints configured; skipping")
        return
    session = make_session(cfg)
    # Templates with a literal {stage} placeholder need a real stage number;
    # skip them (rather than polling a broken URL all session) if none given.
    active_endpoints = {}
    for name, endpoint in cfg.poll_endpoints.items():
        if "{stage}" in endpoint and stage is None:
            print(f"[poll] skipping '{name}' ({endpoint}): needs --stage, none given")
            continue
        active_endpoints[name] = endpoint
    if not active_endpoints:
        print("[poll] no usable poll_endpoints (see above); skipping")
        return
    writers = {name: store.poll_writer(name) for name in active_endpoints}
    last_hash: dict[str, str] = {}
    started = time.monotonic()
    store.write_manifest({"kind": "poll", "endpoints": list(active_endpoints)})
    print(f"[poll] polling {list(active_endpoints)} every {cfg.poll_interval_seconds}s")

    while True:
        if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
            break
        for name, endpoint in active_endpoints.items():
            url = endpoint if endpoint.startswith("http") else cfg.url(endpoint, stage=stage)
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
    """Record cfg.radio_stream_url via ffmpeg, split into hourly files.

    A live stream has no "rewind" — whatever airs while nothing is reading the
    socket is gone forever. So this keeps ONE ffmpeg process (one persistent
    connection) alive for the whole session and lets ffmpeg's own `-f segment`
    muxer cut that continuous decode into hourly files on the output side.
    That's what makes it gapless: unlike restarting a fresh ffmpeg per chunk
    (which pays a reconnect + process-startup cost at every boundary, losing a
    few seconds of live audio each hour), segmenting the output never drops
    the input connection at all. The outer while-loop only exists to restart
    ffmpeg if it dies outright (stream truly disappears longer than
    reconnect_delay_max) — a real gap, but not a self-inflicted one.
    """
    if not cfg.radio_stream_url:
        print("[radio] radio_stream_url not set in config.yaml; skipping. "
              "Find the stream URL (see README 'Radio') and add it.")
        return
    if not shutil.which("ffmpeg"):
        print("[radio] ffmpeg not found on PATH; install it to record radio.")
        return
    store.write_manifest({"kind": "radio", "source": cfg.radio_stream_url})
    started = time.monotonic()
    attempt = 0
    while True:
        if stop_after_seconds and time.monotonic() - started > stop_after_seconds:
            break
        remaining = None
        if stop_after_seconds:
            remaining = max(1, int(stop_after_seconds - (time.monotonic() - started)))
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        pattern = str(store.dir / "radio" / f"radio_{stamp}_%03d.mp3")
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
            "-user_agent", cfg.user_agent,
            "-i", cfg.radio_stream_url,
        ]
        if remaining:
            cmd += ["-t", str(remaining)]
        cmd += [
            "-c:a", "libmp3lame", "-b:a", "64k",
            "-f", "segment", "-segment_time", str(chunk_seconds), "-reset_timestamps", "1",
            pattern,
        ]
        print(f"[radio] recording (single connection, hourly segments) -> {pattern}")
        try:
            subprocess.run(cmd, check=False)
        except KeyboardInterrupt:
            break
        attempt += 1
        print(f"[radio] ffmpeg exited (attempt {attempt}); this is a real gap "
              f"(the live source was unreachable beyond ffmpeg's own reconnect "
              f"window) — reconnecting now")
        time.sleep(2)
    print("[radio] stopped")
