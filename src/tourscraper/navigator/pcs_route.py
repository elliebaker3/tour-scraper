"""Named locations, categorized climbs, and intermediate sprints per stage,
scraped from ProCyclingStats' stage result pages.

PCS blocks a plain HTTP fetch with a Cloudflare JS challenge (also hit by
backfill.py's PCS requests, which 403 outright) -- a real browser context
clears it, so this uses Playwright rather than requests/BeautifulSoup like
the rest of the scraper.

Design, matching backfill.py: SAVE RAW HTML FIRST (pcs-raw/stage-NN.html),
parse separately into pcs-climbs.json. The page changes year to year and the
category inference below is a heuristic (see below) -- keeping the raw page
means re-parsing after a fix costs nothing.

Where climb/sprint locations live on the page
-----------------------------------------------
Each KOM or intermediate-sprint point appears as an <h4> header on the stage
results page, immediately followed by that point's placings table:

    <h4>Sprint | Villefranche-de-Conflent (129 km)</h4><table>...
    <h4>KOM Sprint (1) Col de Mont-Louis (157.8 km)</h4><table>...

PCS does not print the climb's actual category (H.C./1/2/3/4) as text
anywhere on this page. But Grand Tour KOM scoring pays a fixed number of
places per category -- 8 for HC, 5 for cat 1, 3 for cat 2, 2 for cat 3, 1 for
cat 4 -- and the placings table's row count IS that number, so the category
is inferred from it. This is one step removed from ASO's own authoritative
category (the source route_markers() in build_bundle.py uses when a stage
was live-captured) and could be wrong if PCS ever varies a table's row count
for a reason unrelated to category -- the position (km), which is the part
that matters for placing a marker on the bar, does not depend on this.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

PCS_BASE = "https://www.procyclingstats.com"

HEADER_RE = re.compile(
    r'<h4>(Sprint \| |KOM Sprint \(\d+\) )([^<(]+?)\s*\((\d+(?:\.\d+)?)\s*km\)</h4>'
    r'(.*?)</table>', re.S)

# Row count in a KOM point's placings table -> category, per GT KOM scoring
# (see module docstring). Any other row count is left uncategorized rather
# than guessed.
TIER_TO_CAT = {8: "HC", 5: "1", 3: "2", 2: "3", 1: "4"}

DEPARTURE_RE = re.compile(r'Departure:.*?<a href="location/[^"]+">([^<]+)</a>', re.S)
ARRIVAL_RE = re.compile(r'Arrival:.*?<a href="location/[^"]+">([^<]+)</a>', re.S)


def _count_tiers(table_html: str) -> int:
    m = re.search(r"<tbody>(.*?)</tbody>", table_html, re.S)
    body = m.group(1) if m else table_html
    return len(re.findall(r"<tr>", body))


def parse_stage_markers(html: str) -> list[dict]:
    """Extract {kind, km, label, cat} entries from a saved stage page."""
    out = []
    for kind_prefix, name, km, table_html in HEADER_RE.findall(html):
        label = name.strip().rstrip("|").strip()
        km_val = float(km)
        if kind_prefix.startswith("Sprint"):
            out.append({"kind": "sprint", "km": km_val, "label": label})
        else:
            tiers = _count_tiers(table_html)
            cat = TIER_TO_CAT.get(tiers)
            entry = {"kind": "kom", "km": km_val, "label": label}
            if cat:
                entry["cat"] = cat
            else:
                entry["pcs_tiers"] = tiers  # unrecognized tier count -- flagged, not guessed
            out.append(entry)
    out.sort(key=lambda m: m["km"])
    return out


def parse_departure_arrival(html: str) -> tuple[str | None, str | None]:
    dep = DEPARTURE_RE.search(html)
    arr = ARRIVAL_RE.search(html)
    return (dep.group(1).strip() if dep else None,
            arr.group(1).strip() if arr else None)


def fetch_all(race_slug: str, year: int, out_dir: Path, max_stage: int = 21,
              delay_seconds: float = 3.0) -> dict[int, list[dict]]:
    """Fetch every stage page via a real browser context (clears Cloudflare),
    save the raw HTML, and return {stage_number: markers}."""
    from playwright.sync_api import sync_playwright

    raw_dir = out_dir / "pcs-raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    results: dict[int, list[dict]] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for n in range(1, max_stage + 1):
            # A fresh context per stage, not one page.goto()-ed repeatedly:
            # reusing one page across several navigations got Cloudflare's
            # challenge to re-trigger and stick on every request after the
            # first (20/21 stages failed in a row) -- a brand new context
            # per stage, exactly like a fresh visit, cleared it every time
            # in testing.
            ctx = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1400, "height": 1000},
            )
            page = ctx.new_page()
            url = f"{PCS_BASE}/race/{race_slug}/{year}/stage-{n}"
            try:
                page.goto(url, timeout=30000, wait_until="domcontentloaded")
                page.wait_for_timeout(4000)  # let the Cloudflare challenge clear
                html = page.content()
            except Exception as exc:
                print(f"[pcs-route] stage {n}: fetch failed ({exc})")
                ctx.close()
                continue
            ctx.close()
            if "Just a moment" in html[:2000] or "cf-browser-verification" in html:
                print(f"[pcs-route] stage {n}: still behind Cloudflare challenge, skipping")
                continue
            (raw_dir / f"stage-{n:02d}.html").write_text(html, encoding="utf-8")
            markers = parse_stage_markers(html)
            dep, arr = parse_departure_arrival(html)
            results[n] = markers
            print(f"[pcs-route] stage {n}: {dep} -> {arr} · "
                  f"{sum(1 for m in markers if m['kind'] == 'sprint')} sprint(s), "
                  f"{sum(1 for m in markers if m['kind'] == 'kom')} climb(s)")
            time.sleep(delay_seconds)
        browser.close()

    out_path = out_dir / "reference" / "pcs-climbs.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({str(k): v for k, v in results.items()}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"[pcs-route] wrote {len(results)} stage(s) -> {out_path}")
    return results


def load_climbs(out_dir: Path) -> dict[int, list[dict]]:
    """The pcs-climbs.json cache written by fetch_all/reparse_all, keyed by
    stage number. `out_dir` is the race's top-level data dir (e.g.
    data/vuelta/2026) -- the same one passed to fetch_all. A stage missing
    from the file (never fetched, or not yet raced when it was) just gets
    no markers back, same as before this cache existed."""
    path = out_dir / "reference" / "pcs-climbs.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {int(k): v for k, v in raw.items()}


def fetch_race_events(race_slug: str, year: int, stage_n: int, raw_dir: Path) -> str | None:
    """One stage's PCS 'race-events' timeline -- narrower than 'livestats'
    (see backfill.py's PCS_PAGES), but where livestats reverts to a
    post-race results summary once a stage is over, race-events keeps the
    full during-race play-by-play, complete with a km-to-finish on every
    item. That is exactly what a stage with no telemetry AND no
    groups.jsonl (nothing at all to time-sync a t_utc against -- see
    build_bundle.build()'s last resort) needs: a position for every event,
    not just whichever ones happened to name their own km in ASO's ticker
    text. requests hits the same Cloudflare wall here as everywhere else on
    PCS (see this module's docstring); Playwright clears it the same way.
    """
    from playwright.sync_api import sync_playwright

    url = f"{PCS_BASE}/race/{race_slug}/{year}/stage-{stage_n}/live/race-events"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1400, "height": 1000},
        )
        page = ctx.new_page()
        try:
            page.goto(url, timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(4000)
            html = page.content()
        except Exception as exc:
            print(f"[pcs-route] stage {stage_n}: race-events fetch failed ({exc})")
            browser.close()
            return None
        browser.close()
    if "Just a moment" in html[:2000] or "cf-browser-verification" in html:
        print(f"[pcs-route] stage {stage_n}: race-events still behind Cloudflare challenge")
        return None
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"stage-{stage_n:02d}-race-events.html").write_text(html, encoding="utf-8")
    return html


# Reused from extract_events.py rather than duplicated: PCS's race-events
# commentary describes the same kinds of moments ("Attack by...", "caught by
# peloton", "Crash by 3 riders...") in the same kind of plain English ASO's
# own ticker does, so the same regex classify it the same way.
from .extract_events import BREAK_END_RE, BREAK_START_RE, CRASH_RE, HISTORY_RE, NOT_HISTORY_RE  # noqa: E402


def classify_pcs_events(items: list[dict], length_km: float) -> list[dict]:
    """PCS race-events timeline items (see backfill.parse_timeline, 'racing'
    phase only -- pre-start/post-finish items carry no useful km) -> the
    same guidepost shape build_guideposts() produces, keyed by km instead of
    by t_utc: PCS's timeline carries a position on every item and no
    wall-clock time at all, the opposite gap from ASO's ticker. No `t_utc`
    means these can't merge into a full bundle's clock-driven guideposts,
    but they slot straight into a lite bundle's km-placed ones (see
    build_bundle.publish_lite_guideposts) exactly like a ticker item that
    named its own km, just with total coverage instead of whichever few
    happened to.
    """
    guideposts = []
    seen = set()
    for it in items:
        if it.get("phase") != "racing":
            continue
        km_to = it.get("km_to_finish")
        text = it.get("text") or ""
        if km_to is None or not text:
            continue
        # A promotional procession / neutralized-zone item can carry a
        # km-to-finish PCS's own marker parser reads as "racing" but that
        # exceeds the stage's real length (a rolling km_to as high as 215 on
        # a 202.1km stage, seen on stage 2) -- converting one lands at a
        # negative km, caught here rather than downstream.
        km = round(length_km - km_to, 1)
        if km < 0 or km > length_km:
            continue
        if CRASH_RE.search(text):
            category, label = "crash", "Incident"
        elif BREAK_END_RE.search(text):
            category, label = "breakaway_end", "Breakaway caught"
        elif BREAK_START_RE.search(text):
            category, label = "breakaway_start", "Attack"
        elif HISTORY_RE.search(text) and not NOT_HISTORY_RE.search(text):
            category, label = "history", "Race history"
        else:
            continue
        # PCS's own feed occasionally logs one moment twice verbatim (seen
        # on stage 2: the same rider "caught by peloton" back to back at the
        # same km) -- an exact repeat is PCS's duplicate, not two events.
        key = (category, km, text)
        if key in seen:
            continue
        seen.add(key)
        guideposts.append({
            "category": category, "label": label, "detail": text[:400],
            "source": "pcs:race-events", "km": km,
        })
    guideposts.sort(key=lambda g: g["km"])
    return guideposts


def reparse_all(out_dir: Path) -> dict[int, list[dict]]:
    """Re-run parse_stage_markers over already-saved raw HTML -- no fetch."""
    raw_dir = out_dir / "pcs-raw"
    results: dict[int, list[dict]] = {}
    for html_file in sorted(raw_dir.glob("stage-*.html")):
        m = re.search(r"stage-(\d+)", html_file.name)
        if not m:
            continue
        n = int(m.group(1))
        results[n] = parse_stage_markers(html_file.read_text(encoding="utf-8"))
    out_path = out_dir / "reference" / "pcs-climbs.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({str(k): v for k, v in results.items()}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"[pcs-route] reparsed {len(results)} stage(s) -> {out_path}")
    return results
