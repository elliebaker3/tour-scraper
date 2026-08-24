"""Distance/elevation profiles for every La Vuelta a España stage, from komoot.

lavuelta.es embeds one komoot.com tour per stage -- an
`<iframe data-src="https://www.komoot.com/tour/<id>/embed?share_token=...">`,
lazy-loaded so it sits in the page's raw HTML unchanged and needs no headless
browser to find (contrast the Tour's profile CSV, whose hashed filename only
appears after the page's own JS runs -- see autodiscover.py). komoot's API
serves the full route behind that same id+token with no further auth:

  GET https://api.komoot.de/v007/tours/{id}?share_token={token}
      -> name, distance (m), elevation_up/down (m)
  GET https://api.komoot.de/v007/tours/{id}/coordinates?share_token={token}
      -> {"items": [{"lat", "lng", "alt", "t"}, ...]}, one point every few metres

This is the Vuelta's equivalent of this project's GPX source for the Tour: a
dense, real-survey trace with elevation on every point but no climb/sprint
names. gpx_profile's profile builder is reused unchanged so both races'
profile JSON come out the same shape -- kept at full resolution rather than
thinned like the Tour's extension bundles, since the raw trace is only ~1-4k
points per stage and gradientAt()'s 0.5km window needs points in every
window, not just around each summit/valley (what downsample() preserves).
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import requests

from .gpx_profile import profile_from_track

STAGE_PAGE = "https://www.lavuelta.es/en/stage-{n}"
TOUR_RE = re.compile(r"komoot\.com/tour/(\d+)/embed\?share_token=([A-Za-z0-9]+)")
API_TOUR = "https://api.komoot.de/v007/tours/{id}"
API_COORDS = "https://api.komoot.de/v007/tours/{id}/coordinates"

USER_AGENT = "tour-scraper/0.1 (personal archival for a fan project; low request rate)"

# komoot's own `date` field on a tour is when the route was last edited, not
# when the stage is raced -- lavuelta.es's stage pages carry the real date,
# confirmed once here rather than re-scraped every run (the 2026 calendar is
# fixed: 21 stages, 22 Aug - 13 Sep, with rest days after 9 and 15).
STAGE_DATES = {
    1: "2026-08-22", 2: "2026-08-23", 3: "2026-08-24", 4: "2026-08-25",
    5: "2026-08-26", 6: "2026-08-27", 7: "2026-08-28", 8: "2026-08-29",
    9: "2026-08-30", 10: "2026-09-01", 11: "2026-09-02", 12: "2026-09-03",
    13: "2026-09-04", 14: "2026-09-05", 15: "2026-09-06", 16: "2026-09-08",
    17: "2026-09-09", 18: "2026-09-10", 19: "2026-09-11", 20: "2026-09-12",
    21: "2026-09-13",
}

_HEAD_RE = re.compile(r"^Stage \d+:\s*(?:(from)\s+)?(.+?)\s*—", re.IGNORECASE)


def parse_route(name: str) -> tuple[str | None, str | None]:
    """komoot's tour name mixes two formats across the 2026 season -- "Stage
    N: From X to Y" (capitalization of "from" varies -- stage 18 is lower
    case) and, only where departure == arrival, "Stage N: X - Y" with no
    "From". The separator can't be guessed from the two words "to"/"-" alone:
    stage 3 is "From Gruissan - Aude to Font-Romeu", where the region name
    itself contains " - " ahead of the real "to" separator. Whether "From"
    was present is what's reliable, so it picks which separator applies."""
    m = _HEAD_RE.match(name)
    if not m:
        return None, None
    had_from, body = m.group(1), m.group(2)
    sep = " to " if had_from else " - "
    if sep not in body:
        return None, None
    dep, arr = body.split(sep, 1)
    return dep.strip(), arr.strip()


def discover_tours(max_stage: int = 21, session: requests.Session | None = None,
                    sleep_s: float = 1.0) -> dict[int, dict]:
    """Scrape lavuelta.es for every stage's komoot tour id + share token."""
    session = session or requests.Session()
    out: dict[int, dict] = {}
    for n in range(1, max_stage + 1):
        url = STAGE_PAGE.format(n=n)
        resp = session.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
        m = TOUR_RE.search(resp.text)
        if not m:
            print(f"[komoot] stage {n}: no komoot embed found on {url}")
            continue
        tour_id, token = m.group(1), m.group(2)
        out[n] = {"tour_id": tour_id, "share_token": token, "url": url}
        time.sleep(sleep_s)
    return out


def fetch_tour(tour_id: str, share_token: str, session: requests.Session | None = None) -> dict:
    session = session or requests.Session()
    resp = session.get(API_TOUR.format(id=tour_id), params={"share_token": share_token},
                        headers={"User-Agent": USER_AGENT}, timeout=20)
    resp.raise_for_status()
    return resp.json()


def fetch_coordinates(tour_id: str, share_token: str,
                       session: requests.Session | None = None) -> list[tuple[float, float, float]]:
    """(lon, lat, alt) per point, in route order -- the tuple shape gpx_profile expects."""
    session = session or requests.Session()
    resp = session.get(API_COORDS.format(id=tour_id), params={"share_token": share_token},
                        headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    items = resp.json().get("items", [])
    return [(p["lng"], p["lat"], p.get("alt", 0.0)) for p in items]


def write_gpx(points: list[tuple[float, float, float]], dest: Path, name: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="tour-scraper" '
             'xmlns="http://www.topografix.com/GPX/1/1">',
             f"  <trk><name>{name}</name><trkseg>"]
    for lon, lat, alt in points:
        lines.append(f'    <trkpt lat="{lat}" lon="{lon}"><ele>{alt}</ele></trkpt>')
    lines.append("  </trkseg></trk></gpx>")
    dest.write_text("\n".join(lines), encoding="utf-8")


def build(out_dir: Path, max_stage: int = 21, refresh: bool = False) -> list[Path]:
    """Discover every stage's komoot tour (cached to reference/komoot-tours.json
    unless `refresh`), download its route, and write one GPX + one profile
    JSON per stage."""
    ref_dir = out_dir / "reference"
    ref_dir.mkdir(parents=True, exist_ok=True)
    tours_path = ref_dir / "komoot-tours.json"

    if tours_path.exists() and not refresh:
        tours = {int(k): v for k, v in json.loads(tours_path.read_text(encoding="utf-8")).items()}
    else:
        tours = discover_tours(max_stage)
        tours_path.write_text(json.dumps(tours, indent=2), encoding="utf-8")

    session = requests.Session()
    gpx_dir = out_dir / "gpx"
    profiles_dir = out_dir / "profiles" / "komoot"
    profiles_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    stages_summary = []
    for n in sorted(tours):
        t = tours[n]
        meta = fetch_tour(t["tour_id"], t["share_token"], session)
        pts = fetch_coordinates(t["tour_id"], t["share_token"], session)
        if not pts:
            print(f"[komoot] stage {n}: no coordinates returned")
            continue

        name = meta.get("name", f"Stage {n}")
        departure, arrival = parse_route(name)
        official_km = round(meta["distance"] / 1000, 2) if meta.get("distance") else None
        write_gpx(pts, gpx_dir / f"stage-{n}.gpx", name)

        prof = profile_from_track(pts, official_km)
        # No downsample() here, unlike the Tour's extension bundles (target
        # 400). downsample keeps each bucket's high/low point, which clusters
        # the two survivors near each other on a steady grade and leaves gaps
        # elsewhere -- raising the target thins that out but doesn't close
        # it, since the gaps are a property of picking extrema, not of count.
        # Komoot's raw trace is only ~1-4k points per stage (~50-100 KB of
        # JSON), so there's no size reason to thin it: keeping every point
        # guarantees gradientAt's 0.5km window always has points in it.
        prof["stage"] = n
        prof["name"] = name
        prof["date"] = STAGE_DATES.get(n)
        prof["departure"] = departure
        prof["arrival"] = arrival
        prof["elevation_up_m"] = round(meta["elevation_up"]) if meta.get("elevation_up") else None
        prof["elevation_down_m"] = round(meta["elevation_down"]) if meta.get("elevation_down") else None

        dest = profiles_dir / f"stage-{n:02d}.json"
        dest.write_text(json.dumps(prof, ensure_ascii=False, separators=(",", ":")))
        written.append(dest)
        stages_summary.append({
            "stage": n, "name": name, "date": prof["date"],
            "departure": departure, "arrival": arrival, "length_km": prof["length_km"],
            "raw_km": prof["raw_km"], "elevation_up_m": prof["elevation_up_m"],
            "elevation_down_m": prof["elevation_down_m"],
        })
        print(f"[komoot] stage {n}: {len(prof['profile'])} pts, {prof['length_km']}km "
              f"(raw trace {prof['raw_km']}km) -> {dest}")
        time.sleep(1.0)

    # NOT reference/stages.json -- that path is `bootstrap`'s (ASO's own
    # authoritative stage metadata, same schema and same convention the Tour
    # side already relies on). This is a smaller komoot-only summary,
    # informational rather than load-bearing, so it gets its own name instead
    # of racing bootstrap to decide what lands at the shared one.
    (ref_dir / "komoot-stages.json").write_text(
        json.dumps(stages_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return written


def publish_lite_bundles(profiles_dir: Path, extension_data_dir: Path) -> None:
    """Copy every komoot profile into extension/data/ as a "profile" (lite)
    bundle the Navigator can load, and merge it into index.json.

    The Tour already owns stage numbers 1-21 and filenames profile-stage-
    NN.json / stage-NN.json there -- the Vuelta also has 21 stages, so both
    would collide on both axes without care. Files get a `vuelta-` prefix;
    index entries get `race: "vuelta"`, which is how navigator.js's
    stageKey() tells two same-numbered stages from different races apart
    (auto-detection itself never confuses them -- it matches by date, and the
    two seasons don't overlap -- this is only about the manual stage picker
    and pin, which do look stages up by number).
    """
    extension_data_dir.mkdir(parents=True, exist_ok=True)
    index_path = extension_data_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"schema": 1, "stages": []}

    kept = [e for e in index["stages"] if e.get("race") != "vuelta"]
    new_entries = []
    for src in sorted(profiles_dir.glob("stage-*.json")):
        data = json.loads(src.read_text(encoding="utf-8"))
        n = data["stage"]
        bundle = {
            "schema": "profile-1",
            "stage": {"stage": n, "date": data.get("date"), "departure": data.get("departure"),
                      "arrival": data.get("arrival"), "length_km": data.get("length_km"),
                      "scheduled_sec": None},
            "elevation_source": "komoot",
            "profile": data["profile"],
            "markers": [],
        }
        fname = f"vuelta-profile-stage-{n:02d}.json"
        (extension_data_dir / fname).write_text(
            json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
        dep, arr = data.get("departure"), data.get("arrival")
        new_entries.append({
            "file": fname, "stage": n, "race": "vuelta", "date": data.get("date"),
            "route": f"{dep} → {arr}" if dep and arr else None, "kind": "profile",
        })

    index["stages"] = sorted([*kept, *new_entries], key=lambda e: e.get("date") or "")
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[komoot] published {len(new_entries)} lite bundle(s) to {extension_data_dir}; "
          f"index now covers {len(index['stages'])} stage(s)")
