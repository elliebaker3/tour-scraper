"""Per-rider start/intermediate/arrival times for a race with an individual
start (e.g. an ITT), scraped from the racecenter page itself.

There is no clean JSON endpoint for this -- confirmed by capturing every
network response (JSON and otherwise) a real page load makes: departure
times are computed client-side (start order N -> stage.startTime + (N-1) x
60s) and rendered straight into a Quasar `q-table`, never sent over the wire
as their own field. `allCompetitors-{year}` carries no start-order field
either, so the order itself isn't independently derivable -- the rendered
table is the only place this exists. Scraped with a real headless browser
(Playwright, already a dependency via autodiscover.py) rather than reverse-
engineered, because that DOM is the actual source of truth here, not a
proxy for one.

The table has one row per rider:
  start order | rider name | bib | team | departure time |
  intermediate-point split | arrival split
Both splits render "-" until that rider has passed the point, then a gap-to-
leader plus their live position, e.g. `+00'17" (17)`.

Snapshotted repeatedly (like every other poll in this project) rather than
scraped once, since intermediate/arrival cells fill in live as the stage
runs -- one scrape only ever sees whatever had finished by that moment.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

COLUMNS = ("start_order", "rider", "bib", "team", "departure",
           "intermediate", "arrival")


def scrape_startlist(base_url: str, timeout_ms: int = 30000) -> list[dict]:
    """One full snapshot of the departure/intermediate/arrival table."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1600, "height": 1400})
            page.goto(f"{base_url}/en/", wait_until="load", timeout=timeout_ms)
            page.wait_for_timeout(4000)
            # Cookie banner blocks the table's pagination control underneath it.
            try:
                page.click("text=Accept non essential cookies", timeout=3000)
            except Exception:
                pass
            page.wait_for_selector("table.q-table tbody tr", timeout=timeout_ms)
            # Table paginates at 10 rows by default; "See All" renders every
            # row in the DOM at once so one pass reads the whole field --
            # see this module's docstring for why there's no API shortcut.
            page.click(".q-table__select")
            page.wait_for_timeout(400)
            page.click("text=See All")
            page.wait_for_timeout(1500)

            rows = page.eval_on_selector_all(
                "table.q-table tbody tr",
                """els => els.map(tr =>
                     Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
                   )""",
            )
        finally:
            browser.close()

    return [dict(zip(COLUMNS, r)) for r in rows if len(r) >= len(COLUMNS)]


def run_loop(base_url: str, out_dir: Path, stop_after_seconds: float,
             interval_seconds: float = 120) -> None:
    """Snapshot on an interval until stop_after_seconds elapses, appending
    each one (with its capture time) to startlist.jsonl -- one line per
    snapshot, same shape as this project's other polls/*.jsonl files."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / "startlist.jsonl"
    deadline = time.monotonic() + stop_after_seconds
    while time.monotonic() < deadline:
        started = time.monotonic()
        try:
            rows = scrape_startlist(base_url)
            with dest.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                    "riders": rows,
                }, ensure_ascii=False) + "\n")
            print(f"[startlist] {len(rows)} riders -> {dest}")
        except Exception as exc:  # a bad scrape shouldn't kill the whole loop
            print(f"[startlist] scrape failed: {exc}")
        elapsed = time.monotonic() - started
        time.sleep(max(0.0, interval_seconds - elapsed))
