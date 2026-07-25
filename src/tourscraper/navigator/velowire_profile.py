"""Distance/elevation profiles for every stage, from velowire.com's KMZ.

Live capture only exists for stages the scraper actually ran during (14, 15,
16, 17, 19 so far -- see build_bundle.py). For every other stage there is no
leader-position timeline to sync a profile to a recording, so there is no
"navigator bundle" to build -- but a reference elevation profile is still
useful on its own, and velowire.com publishes exactly that for the whole
route in one file: a KMZ meant for Google Earth import (their own copyright
note names that as an intended use, unlike their profile *images*, which this
deliberately never touches -- see README's note by the caller).

The KMZ has one Folder per stage (index 0 is team-presentation, skip it;
folder N is stage N), containing:
  - one or more <LineString> Placemarks: the traced route, each vertex a
    (lon, lat, altitude) triple. Stages with a finishing circuit (21) encode
    each lap as its own LineString in ride order, so concatenating every
    LineString in document order reconstructs the full distance including
    laps.
  - <Point> Placemarks for départ/arrivée/climbs/sprints, named with the same
    HC/1/2/3/4 category convention already used in build_bundle.py's
    _KOM_LABEL, e.g. "Col du Tourmalet (HC)", "sprint - Pouzac",
    "arrivée - Gavarnie-Gèdre (2)" (a categorized summit finish).

Distance is a cumulative haversine sum along the LineString vertices. That
consistently runs a few percent past the official stage length (worse on
mountain stages -- likely the traced route occasionally detours from the
exact racing line through a road network match, not a curvature artifact:
even the short, flat stage 16 comes out within 0.4%). Rather than ship a
"128km" profile whose own axis reads 133.6, every km value is linearly
rescaled so the profile's total matches stages.json's official length --
recorded as `raw_km` alongside the rescaled `length_km` so the correction is
inspectable, not silent.
"""

from __future__ import annotations

import json
import math
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import requests

KMZ_URL = "https://short.thover.com/?ID=1263"  # velowire's own short-link for the season's KMZ
KML_NS = {"k": "http://www.opengis.net/kml/2.2"}

# Same convention as build_bundle.py's _KOM_LABEL, just the reverse mapping
# (velowire already spells out "HC"/"1".."4", so this is closer to identity).
_KOM_CATS = {"HC", "1", "2", "3", "4"}


def fetch_kmz(dest: Path, session: requests.Session | None = None) -> Path:
    session = session or requests.Session()
    resp = session.get(KMZ_URL, timeout=30)
    resp.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(resp.content)
    return dest


def _haversine_km(lo1: float, la1: float, lo2: float, la2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(la1), math.radians(la2)
    dphi = math.radians(la2 - la1)
    dlmb = math.radians(lo2 - lo1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _parse_marker_name(name: str) -> dict | None:
    """Classify a Point placemark's name into a route marker, or None if it's
    just a routing waypoint (départ / km 0) with nothing worth showing."""
    name = name.strip()
    cat_match = re.search(r"\((HC|[1-4])\)\s*$", name)
    cat = cat_match.group(1) if cat_match else None
    base = name[: cat_match.start()].strip() if cat_match else name

    if base.startswith("arrivée"):
        return {"kind": "finish", "cat": cat, "label": base.split("-", 1)[-1].strip()}
    if base.startswith("sprint"):
        return {"kind": "sprint", "label": base.split("-", 1)[-1].strip()}
    if cat in _KOM_CATS:
        return {"kind": "kom", "cat": cat, "label": base}
    return None  # départ / km 0 / anything unclassified


def downsample(points: list[dict], target: int = 400) -> list[dict]:
    """Thin to ~target points, keeping each bucket's high and low so summits
    and valley floors survive -- same approach as build_bundle.downsample_profile."""
    if len(points) <= target:
        return points
    bucket = max(1, len(points) // (target // 2))
    out: list[dict] = []
    for i in range(0, len(points), bucket):
        chunk = points[i : i + bucket]
        if not chunk:
            continue
        hi = max(chunk, key=lambda p: p["alt"])
        lo = min(chunk, key=lambda p: p["alt"])
        for p in sorted({id(hi): hi, id(lo): lo}.values(), key=lambda p: p["km"]):
            if not out or out[-1]["km"] != p["km"]:
                out.append(p)
    return out


def parse_stage(folder: ET.Element, official_length_km: float | None) -> dict:
    """One stage Folder -> {profile: [{km, alt}], markers: [...], raw_km, length_km}."""
    coords: list[tuple[float, float, float]] = []
    markers_raw: list[tuple[float, float, dict]] = []  # (lon, lat, marker)

    for pm in folder.findall("k:Placemark", KML_NS):
        name_el = pm.find("k:name", KML_NS)
        name = (name_el.text or "").strip() if name_el is not None else ""
        ls = pm.find("k:LineString", KML_NS)
        if ls is not None:
            raw = ls.find("k:coordinates", KML_NS).text.strip().split()
            for c in raw:
                lo, la, alt = (float(v) for v in c.split(","))
                coords.append((lo, la, alt))
            continue
        pt = pm.find("k:Point", KML_NS)
        if pt is not None:
            marker = _parse_marker_name(name)
            if marker:
                lo, la, _alt = (float(v) for v in pt.find("k:coordinates", KML_NS).text.strip().split(","))
                markers_raw.append((lo, la, marker))

    if not coords:
        return {"profile": [], "markers": [], "raw_km": 0.0, "length_km": official_length_km}

    profile = [{"km": 0.0, "alt": round(coords[0][2])}]
    cum = 0.0
    for i in range(1, len(coords)):
        cum += _haversine_km(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
        profile.append({"km": round(cum, 3), "alt": round(coords[i][2])})
    raw_km = cum

    scale = (official_length_km / raw_km) if (official_length_km and raw_km) else 1.0
    for p in profile:
        p["km"] = round(p["km"] * scale, 2)

    # Position each marker at the km of its nearest vertex on the line.
    markers = []
    for lo, la, marker in markers_raw:
        best_i, best_d = 0, float("inf")
        for i, (clo, cla, _) in enumerate(coords):
            d = (clo - lo) ** 2 + (cla - la) ** 2  # cheap proxy; route is dense enough
            if d < best_d:
                best_d, best_i = d, i
        marker["km"] = profile[best_i]["km"]
        markers.append(marker)
    markers.sort(key=lambda m: m["km"])

    return {
        "profile": downsample(profile),
        "markers": markers,
        "raw_km": round(raw_km, 2),
        "length_km": round(official_length_km, 2) if official_length_km else round(raw_km, 2),
    }


def parse_all_stages(kml_path: Path, stages_meta: dict[int, dict]) -> dict[int, dict]:
    """stages_meta: stage number -> {"length_km": ..., "date": ..., "departure": ..., "arrival": ...}."""
    tree = ET.parse(kml_path)
    doc = tree.getroot().find("k:Document", KML_NS)
    folders = doc.findall("k:Folder", KML_NS)

    out: dict[int, dict] = {}
    for idx, folder in enumerate(folders):
        if idx == 0:
            continue  # team presentation, not a stage
        meta = stages_meta.get(idx, {})
        result = parse_stage(folder, meta.get("length_km"))
        result["stage"] = idx
        result["date"] = meta.get("date")
        result["departure"] = meta.get("departure")
        result["arrival"] = meta.get("arrival")
        out[idx] = result
    return out


def build(year_dir: Path, out_dir: Path | None = None) -> list[Path]:
    """Download the KMZ, parse every stage, write one JSON per stage.

    stages.json (already bootstrapped) supplies official length + names so
    the distance axis can be rescaled and the output is self-describing
    without a second network round-trip.
    """
    stages_path = year_dir / "reference" / "stages.json"
    if not stages_path.exists():
        raise SystemExit(f"{stages_path} missing; run `tourscraper bootstrap` first")
    stages_meta = {}
    for s in json.loads(stages_path.read_text(encoding="utf-8")):
        n = s.get("stage")
        if n is None:
            continue
        stages_meta[n] = {
            "length_km": s.get("length") or s.get("lengthDisplay"),
            "date": str(s.get("date", ""))[:10],
            "departure": (s.get("departureCity") or {}).get("label"),
            "arrival": (s.get("arrivalCity") or {}).get("label"),
        }

    out_dir = out_dir or (year_dir / "profiles" / "velowire")
    out_dir.mkdir(parents=True, exist_ok=True)

    tmp_kmz = out_dir / "_tour-de-france.kmz"
    fetch_kmz(tmp_kmz)
    with zipfile.ZipFile(tmp_kmz) as zf:
        kml_name = next(n for n in zf.namelist() if n.endswith(".kml") and "__MACOSX" not in n)
        kml_bytes = zf.read(kml_name)
    kml_path = out_dir / "_doc.kml"
    kml_path.write_bytes(kml_bytes)

    stages = parse_all_stages(kml_path, stages_meta)
    written = []
    for n, data in sorted(stages.items()):
        dest = out_dir / f"stage-{n:02d}.json"
        dest.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        written.append(dest)
        print(f"[velowire] stage {n}: {len(data['profile'])} pts, "
              f"{len(data['markers'])} markers, {data['length_km']}km "
              f"(raw trace {data['raw_km']}km) -> {dest}")

    tmp_kmz.unlink(missing_ok=True)
    kml_path.unlink(missing_ok=True)
    return written


def publish_lite_bundles(velowire_dir: Path, extension_data_dir: Path) -> None:
    """Copy every velowire profile that ISN'T already covered by a real
    (time-synced) navigator bundle into extension/data/ as a lite bundle, and
    rewrite index.json so the stage picker offers all 21 stages.

    Which stages already have a real bundle is read from index.json itself
    (entries without "kind" predate this and are real bundles too) rather
    than hardcoded here, so this stays correct as more stages get captured
    without needing an edit in two places.
    """
    index_path = extension_data_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"schema": 1, "stages": []}

    full_entries = {e["stage"]: e for e in index["stages"] if e.get("kind", "full") == "full"}
    for e in full_entries.values():
        e.setdefault("kind", "full")

    lite_entries = {}
    for n in sorted(full_entries.keys() | {int(p.stem.split("-")[1]) for p in velowire_dir.glob("stage-*.json")}):
        if n in full_entries:
            continue
        src = velowire_dir / f"stage-{n:02d}.json"
        if not src.exists():
            continue
        data = json.loads(src.read_text(encoding="utf-8"))
        dep, arr = data.get("departure"), data.get("arrival")
        bundle = {
            "schema": "profile-1",
            "stage": {"stage": n, "date": data.get("date"), "departure": dep,
                     "arrival": arr, "length_km": data.get("length_km")},
            "profile": data["profile"],
            "markers": data["markers"],
        }
        fname = f"profile-stage-{n:02d}.json"
        (extension_data_dir / fname).write_text(
            json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
        lite_entries[n] = {
            "file": fname, "stage": n, "date": data.get("date"),
            "route": f"{dep} → {arr}" if dep and arr else None,
            "kind": "profile",
        }

    index["stages"] = sorted([*full_entries.values(), *lite_entries.values()],
                             key=lambda e: e["stage"])
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[velowire] published {len(lite_entries)} lite bundle(s); "
          f"index now covers {len(index['stages'])} stage(s)")
