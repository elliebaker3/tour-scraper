"""Backfill archived race data for stages that already happened.

Sources:
  1. ProCyclingStats LiveStats archive. After a stage ends, PCS keeps the full
     timeline at /race/tour-de-france/{year}/stage-{n}/live/livestats plus
     focused sub-pages. Timeline items are keyed by a marker whose meaning
     (per PCS's own legend) is:
        P        preview item
        3h / 27m time before start
        -3.2     km before the official start
        171      km to the FINISH  <- during-race items, the ones the
                                      Navigator cares about
        F        after the finish
  2. letour.fr stage pages (official race review / ticker), best-effort since
     the URL layout shifts year to year.

Design: SAVE RAW HTML FIRST (backfill/pcs/*.html, backfill/letour/*.html),
then parse heuristically into events.pcs.jsonl. The parser is intentionally
tolerant and records how much it could/couldn't parse; improve it after
looking at the saved HTML and re-run with `backfill-reparse` — no re-fetching.

Politeness: one page every DELAY_SECONDS, honest UA, ~7 pages/stage. PCS is a
small ad-supported site: keep this to one-off backfills, keep the archive
personal, and consider their PCS PRO subscription if you lean on the site.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from bs4 import BeautifulSoup

from .config import Config
from .storage import JsonlWriter, StageStore, utcnow
from .static_api import get_with_retry, make_session

import os
PCS_BASE = os.environ.get("PCS_BASE", "https://www.procyclingstats.com")
LETOUR_BASE = os.environ.get("LETOUR_BASE", "https://www.letour.fr")
PCS_RACE = "race/tour-de-france"
DELAY_SECONDS = float(os.environ.get("PCS_DELAY", "4.0"))

# Sub-pages worth archiving per stage (name -> path suffix under .../stage-N/)
PCS_PAGES = {
    "livestats": "live/livestats",
    "race-events": "live/race-events",
    "breakaway-gap": "live/breakaway-gap",
    "virtual-gc": "live/gc",
    "weather-during-race": "live/weather-during-race",
    "result": "result",
}

MARKER_RE = re.compile(r"^(P|F|\d+h|\d+m|-?\d+(?:\.\d+)?)$")
START_DATE_RE = re.compile(r"Start\D{0,10}(\d{1,2})/(\d{1,2})")


def classify_marker(marker: str) -> dict:
    """Turn a PCS timeline marker into structured timing info."""
    if marker == "P":
        return {"phase": "preview"}
    if marker == "F":
        return {"phase": "post-finish"}
    if marker.endswith("h") and marker[:-1].isdigit():
        return {"phase": "pre-start", "hours_to_start": int(marker[:-1])}
    if marker.endswith("m") and marker[:-1].isdigit():
        return {"phase": "pre-start", "minutes_to_start": int(marker[:-1])}
    try:
        value = float(marker)
    except ValueError:
        return {"phase": "unknown"}
    if value < 0:
        return {"phase": "neutralized", "km_before_official_start": -value}
    return {"phase": "racing", "km_to_finish": value}


def parse_timeline(html: str) -> tuple[list[dict], dict]:
    """Heuristic parse of a PCS livestats/race-events page.

    Strategy: PCS renders timeline entries as list items. For each <li>, if it
    begins with a recognizable marker token, treat the remainder as the item
    text. Everything that doesn't match is counted, not lost (raw HTML is on
    disk anyway).
    """
    soup = BeautifulSoup(html, "html.parser")
    items: list[dict] = []
    stats = {"li_total": 0, "matched": 0}
    for li in soup.find_all("li"):
        stats["li_total"] += 1
        text = " ".join(li.get_text(" ", strip=True).split())
        if not text:
            continue
        first_token, _, rest = text.partition(" ")
        if not MARKER_RE.match(first_token) or not rest:
            continue
        # Skip pure-navigation <li> (all-link content)
        links = li.find_all("a")
        link_text_len = sum(len(a.get_text(strip=True)) for a in links)
        if link_text_len >= len(text) - len(first_token):
            continue
        stats["matched"] += 1
        items.append({
            "marker": first_token,
            **classify_marker(first_token),
            "text": rest,
            "links": [a.get("href") for a in links if a.get("href")][:5],
        })
    return items, stats


def parse_stage_date(html: str, year: int) -> str | None:
    m = START_DATE_RE.search(BeautifulSoup(html, "html.parser").get_text(" "))
    if m:
        day, month = int(m.group(1)), int(m.group(2))
        return f"{year}-{month:02d}-{day:02d}"
    return None


def backfill_stage(cfg: Config, session, stage_no: int) -> None:
    stage_base = f"{PCS_BASE}/{PCS_RACE}/{cfg.year}/stage-{stage_no}"
    pages: dict[str, str] = {}
    for name, suffix in PCS_PAGES.items():
        url = f"{stage_base}/{suffix}"
        try:
            resp = get_with_retry(session, cfg, url)
            if resp.status_code == 200:
                pages[name] = resp.text
                print(f"[backfill] stage {stage_no}: fetched {name} "
                      f"({len(resp.text)} bytes)")
            else:
                print(f"[backfill] stage {stage_no}: {name} -> HTTP {resp.status_code}")
        except Exception as exc:
            print(f"[backfill] stage {stage_no}: {name} FAILED {exc}")
        time.sleep(DELAY_SECONDS)

    if not pages:
        print(f"[backfill] stage {stage_no}: nothing fetched, skipping")
        return

    date = None
    for html in pages.values():
        date = parse_stage_date(html, cfg.year)
        if date:
            break
    store = StageStore(cfg.year_dir, stage_no, date)
    raw_dir = store.dir / "backfill" / "pcs"
    raw_dir.mkdir(parents=True, exist_ok=True)
    for name, html in pages.items():
        (raw_dir / f"{name}.html").write_text(html, encoding="utf-8")

    _parse_saved(store, stage_no)

    # Best-effort letour.fr official page for the same stage (raw only; the
    # markup changes too often to promise a parser).
    letour_url = f"{LETOUR_BASE}/en/stage-{stage_no}"
    try:
        resp = get_with_retry(session, cfg, letour_url)
        if resp.status_code == 200:
            ldir = store.dir / "backfill" / "letour"
            ldir.mkdir(parents=True, exist_ok=True)
            (ldir / "stage.html").write_text(resp.text, encoding="utf-8")
            print(f"[backfill] stage {stage_no}: saved letour page")
        else:
            print(f"[backfill] stage {stage_no}: letour -> HTTP {resp.status_code} "
                  f"(URL pattern may differ this year; find it in a browser and "
                  f"fetch manually, or adjust letour_url in backfill.py)")
    except Exception as exc:
        print(f"[backfill] stage {stage_no}: letour FAILED {exc}")
    time.sleep(DELAY_SECONDS)

    store.write_manifest({"kind": "backfill", "stage": stage_no,
                          "pcs_pages": sorted(pages)})


def _parse_saved(store: StageStore, stage_no: int) -> None:
    """(Re)parse saved PCS HTML into events.pcs.jsonl."""
    raw_dir = store.dir / "backfill" / "pcs"
    out_path = store.dir / "events.pcs.jsonl"
    if out_path.exists():
        out_path.unlink()  # full rebuild; source of truth is the saved HTML
    writer = JsonlWriter(out_path)
    totals = {"items": 0}
    for html_file in sorted(raw_dir.glob("*.html")):
        page = html_file.stem
        if page == "result":
            continue
        items, stats = parse_timeline(html_file.read_text(encoding="utf-8"))
        for order, item in enumerate(items):
            writer.write({"captured_at": utcnow(), "source": f"pcs:{page}",
                          "stage": stage_no, "order": order, **item})
        totals["items"] += len(items)
        print(f"[backfill] stage {stage_no}: parsed {page}: "
              f"{stats['matched']}/{stats['li_total']} list items -> events")
    writer.close()
    print(f"[backfill] stage {stage_no}: wrote {totals['items']} items -> {out_path}")
    if totals["items"] == 0:
        print("[backfill] NOTE: 0 items parsed — the heuristic didn't match this "
              "page structure. The raw HTML is saved; inspect it, adjust "
              "parse_timeline(), then run `backfill-reparse`. Nothing was lost.")


def run_backfill(cfg: Config, stages: str) -> None:
    session = make_session(cfg)
    session.headers["Accept"] = "text/html"
    for stage_no in _expand(stages):
        backfill_stage(cfg, session, stage_no)


def reparse_backfill(cfg: Config, stage_dir: str) -> None:
    path = Path(stage_dir)
    m = re.search(r"stage-(\d+)", path.name)
    stage_no = int(m.group(1)) if m else -1
    store = StageStore.__new__(StageStore)  # rebind to existing dir, no mkdir games
    store.dir = path
    _parse_saved(store, stage_no)


def _expand(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo), int(hi) + 1))
        elif part:
            out.append(int(part))
    return out
