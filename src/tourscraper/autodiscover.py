"""Automatic replacement for the manual HAR-capture workflow.

Manually, discovering the radio stream URL / commentary feed / elevation
profile mechanism means: open racecenter.letour.fr in a real browser during a
live stage, open DevTools, let it run a couple minutes, export a HAR. This
module does the same thing with a headless Chromium (via Playwright) so it can
run unattended in CI, with no one at a keyboard.

It captures three kinds of live signal:
  - every HTTP request/response (like a HAR), classified the same way
    har_discover.analyze_har does
  - Server-Sent-Event frames on the page's own EventSource connections (via
    CDP's Network.eventSourceMessageReceived) -- this is how we can see bind
    names actually flowing (telemetryCompetitor-*, pack-*, and whatever the
    2026 elevation-profile bind turns out to be) without guessing
  - it also tries to click a radio/play control if one is visible, since the
    audio stream URL sometimes only starts loading after a user interaction

Findings are saved to data/{year}/reference/autodiscover-endpoints.json
(always) and, where confident, patched directly into config.yaml so the next
`stage` run picks them up with no human step in between. This repo is
private, so committing the discovered radio URL straight into config.yaml is
fine -- simpler than juggling GitHub Actions secrets.
"""

from __future__ import annotations

import json
import re
import time

import yaml

from .config import Config
from .har_discover import BORING, INTERESTING_TYPES
from .static_api import get_with_retry, make_session
from .storage import StageStore, save_reference, utcnow

RADIO_SELECTORS = [
    "[class*='radio' i] button",
    "[class*='radio' i]",
    "[aria-label*='radio' i]",
    "[class*='play' i] button",
]


def _classify(url: str, mime: str) -> str | None:
    if BORING.search(url):
        return None
    kind = next((t for t in INTERESTING_TYPES if t in mime), None)
    if not kind and "/api/" in url:
        kind = "api-path"
    return kind


def run_autodiscover(cfg: Config, watch_seconds: int = 150, apply_config: bool = True) -> dict:
    from playwright.sync_api import sync_playwright  # imported lazily; optional dep

    http_events: list[dict] = []
    sse_events: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=cfg.user_agent)
        page = context.new_page()

        def on_response(resp):
            try:
                mime = resp.headers.get("content-type", "") or ""
                kind = _classify(resp.url, mime)
                if not kind:
                    return
                sample = ""
                if kind in ("json", "api-path"):
                    try:
                        sample = resp.text()[:400]
                    except Exception:
                        sample = ""
                http_events.append({
                    "captured_at": utcnow(), "url": resp.url, "status": resp.status,
                    "mime": mime, "kind": kind, "sample": sample,
                })
            except Exception:
                pass

        page.on("response", on_response)

        # CDP session to see individual SSE frames -- Playwright has no
        # high-level API for this, so we go straight to the protocol.
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")

        def on_sse(params):
            try:
                data = params.get("eventName") and params or params
                sse_events.append({"captured_at": utcnow(), **params})
            except Exception:
                pass

        cdp.on("Network.eventSourceMessageReceived", on_sse)

        print(f"[autodiscover] loading {cfg.base_url}/en/ ...")
        # NOT "networkidle": the page keeps a persistent SSE connection open
        # by design (that IS the live-stream), so network activity never goes
        # idle -- networkidle would time out on every single run.
        page.goto(cfg.base_url + "/en/", wait_until="load", timeout=30000)

        for selector in RADIO_SELECTORS:
            try:
                el = page.query_selector(selector)
                if el:
                    el.click(timeout=2000)
                    print(f"[autodiscover] clicked candidate radio control: {selector}")
                    break
            except Exception:
                continue

        print(f"[autodiscover] watching network + SSE for {watch_seconds}s ...")
        deadline = time.monotonic() + watch_seconds
        while time.monotonic() < deadline:
            page.wait_for_timeout(1000)

        browser.close()

    by_kind: dict[str, list[dict]] = {}
    for ev in http_events:
        by_kind.setdefault(ev["kind"], []).append(ev)

    sse_binds: dict[str, int] = {}
    for ev in sse_events:
        try:
            payload = json.loads(ev.get("data", "{}"))
            bind = str(payload.get("bind", "")).split("-")[0] or "(unknown)"
        except Exception:
            bind = "(unparseable)"
        sse_binds[bind] = sse_binds.get(bind, 0) + 1

    inventory = {
        "http_by_kind": {k: v[:20] for k, v in by_kind.items()},
        "sse_binds_seen": sse_binds,
        "sse_sample_events": sse_events[:10],
    }
    path = save_reference(cfg.year_dir, "autodiscover-endpoints", inventory)
    print(f"[autodiscover] full inventory -> {path}")
    print(f"[autodiscover] HTTP kinds seen: { {k: len(v) for k, v in by_kind.items()} }")
    print(f"[autodiscover] SSE binds seen: {sse_binds}")

    live_urls = sorted({e["url"] for e in by_kind.get("event-stream", [])})
    if live_urls:
        print(f"[autodiscover] NOTE: real /live-stream requests carry a signed "
              f"'xdt' query token (short-lived, issued at page-load time) that "
              f"this scraper does not send. A plain request without it still "
              f"got HTTP 200 + text/event-stream during this run, so it's "
              f"likely optional analytics rather than required auth -- but "
              f"that's unconfirmed until verified against a real live stage. "
              f"Example captured URL: {live_urls[0][:90]}...")

    downloaded = _download_profiles(cfg, by_kind)

    applied = {}
    if apply_config:
        applied = _apply_findings(cfg, by_kind)
    return {"http_by_kind": by_kind, "sse_binds": sse_binds, "applied": applied,
            "profiles_downloaded": downloaded}


def _download_profiles(cfg: Config, by_kind: dict) -> list:
    """Download every distinct elevation-profile CSV the browser actually
    fetched. These carry an opaque content hash in the filename that isn't
    predictable/regex-able from static HTML or JS -- only a real browser
    session (or reading this saved inventory) reveals it."""
    urls = sorted({e["url"] for e in by_kind.get("csv", []) if "/profils/" in e["url"]})
    if not urls:
        print("[autodiscover] no profile CSVs observed this run")
        return []
    session = make_session(cfg)
    shared = cfg.year_dir / "profiles"
    shared.mkdir(parents=True, exist_ok=True)
    saved = []
    for url in urls:
        fname = url.rsplit("/", 1)[-1]
        try:
            resp = get_with_retry(session, cfg, url)
            resp.raise_for_status()
            (shared / fname).write_bytes(resp.content)
            print(f"[autodiscover] saved profile CSV -> {shared / fname} "
                  f"({len(resp.content)} bytes)")
            saved.append(str(shared / fname))
            m = re.search(r"profile-(\d+)", fname)
            if m:
                store = StageStore(cfg.year_dir, int(m.group(1)))
                (store.dir / "profile.csv").write_bytes(resp.content)
                store.write_manifest({"kind": "profile", "source": url, "via": "autodiscover"})
        except Exception as exc:
            print(f"[autodiscover] FAILED downloading {url}: {exc}")
    return saved


def _apply_findings(cfg: Config, by_kind: dict[str, list[dict]]) -> dict:
    """Best-effort: patch config.yaml with high-confidence findings only.

    Only acts when a category has exactly one distinct candidate URL -- if
    there's ambiguity, leave config.yaml untouched and let a human decide
    from the saved inventory instead of guessing wrong.
    """
    from .config import DEFAULT_CONFIG_PATH
    config_path = DEFAULT_CONFIG_PATH
    raw = yaml.safe_load(config_path.read_text()) or {} if config_path.exists() else {}
    applied = {}

    audio_urls = sorted({e["url"] for e in by_kind.get("mpegurl", []) + by_kind.get("audio", [])})
    if len(audio_urls) == 1 and not raw.get("radio_stream_url"):
        raw["radio_stream_url"] = audio_urls[0]
        applied["radio_stream_url"] = audio_urls[0]
        print(f"[autodiscover] applying radio_stream_url = {audio_urls[0]}")
    elif len(audio_urls) > 1:
        print(f"[autodiscover] {len(audio_urls)} audio candidates found, ambiguous, "
              f"not auto-applied -- check autodiscover-endpoints.json: {audio_urls}")

    commentary_candidates = [
        e for e in by_kind.get("json", []) + by_kind.get("api-path", [])
        if re.search(r"comment|feed|ticker|news", e["url"], re.I)
    ]
    distinct = sorted({e["url"].split("?")[0] for e in commentary_candidates})
    existing_polls = raw.get("poll_endpoints") or {}
    if len(distinct) == 1 and "commentary" not in existing_polls:
        existing_polls = dict(existing_polls)
        existing_polls["commentary"] = distinct[0]
        raw["poll_endpoints"] = existing_polls
        applied["poll_endpoints.commentary"] = distinct[0]
        print(f"[autodiscover] applying poll_endpoints.commentary = {distinct[0]}")
    elif len(distinct) > 1:
        print(f"[autodiscover] {len(distinct)} commentary-like candidates, ambiguous, "
              f"not auto-applied: {distinct}")

    if applied:
        config_path.write_text(
            "# tour-scraper configuration. Everything here overrides the defaults in\n"
            "# src/tourscraper/config.py.\n\n" + yaml.safe_dump(raw, sort_keys=False)
        )
        print(f"[autodiscover] wrote {config_path}")
    else:
        print("[autodiscover] nothing auto-applied; config.yaml unchanged")
    return applied