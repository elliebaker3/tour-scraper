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
