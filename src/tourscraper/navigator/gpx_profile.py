"""Distance/elevation profiles from the official per-stage GPX tracks.

These are the route as surveyed -- one dense polyline per stage with an
elevation on every point (stage 19 carries 5779) -- and they are the best
elevation source available to this project:

* Better resolution than anything else we hold, and no rescaling guesswork:
  the track is the actual route, not a traced approximation.
* Complete for every stage that downloaded, including ones the scraper never
  captured live.

They carry NO names or waypoints, though -- purely track points -- so climb
names still come from velowire (see velowire_profile.name_route_markers) and
checkpoint positions still come from ASO's profile.csv. This module supplies
the SHAPE and nothing else.

Distance is cumulative haversine along the track. That lands within a few
tenths of the official length on most stages, but it is still rescaled to
`stages.json`, for the same reason velowire's is: every other number in a
bundle is on ASO's scale, and mixing scales is what reintroduces the constant
offset the elevation sync exists to remove.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET

GPX_NS = {"g": "http://www.topografix.com/GPX/1/0",
          "g11": "http://www.topografix.com/GPX/1/1"}


def _haversine_km(lo1: float, la1: float, lo2: float, la2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(la1), math.radians(la2)
    dphi = math.radians(la2 - la1)
    dlmb = math.radians(lo2 - lo1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def read_track(path: Path) -> list[tuple[float, float, float]]:
    """(lon, lat, elevation) for every track point, in route order.

    Handles GPX 1.0 and 1.1, which differ only by namespace -- the files here
    are GPSBabel 1.0 output, but a re-export could easily be 1.1.
    """
    root = ET.parse(path).getroot()
    pts: list[tuple[float, float, float]] = []
    for prefix in ("g", "g11"):
        for trkpt in root.iterfind(f".//{prefix}:trkpt", GPX_NS):
            ele = trkpt.find(f"{prefix}:ele", GPX_NS)
            pts.append((float(trkpt.get("lon")), float(trkpt.get("lat")),
                        float(ele.text) if ele is not None and ele.text else 0.0))
        if pts:
            break
    return pts


# A GPX track measures the route it was drawn for. Where it disagrees with
# stages.json by more than this, the two are describing DIFFERENT routes
# rather than the same one measured slightly differently -- stage 9 was
# shortened mid-Tour for a heatwave and the track is still the original, a
# 31 km gap. Rescaling across that would squeeze the real terrain by 20% and
# put every climb in the wrong place, so the raw distance is kept and the
# mismatch reported instead.
MAX_RESCALE_DRIFT_KM = 5.0


def profile_from_track(pts, official_length_km: float | None = None) -> dict:
    """Track points -> [{km, alt}] with a cumulative-distance axis."""
    if not pts:
        return {"profile": [], "raw_km": 0.0, "length_km": official_length_km,
                "scale": 1.0, "note": "empty track"}
    prof = [{"km": 0.0, "alt": round(pts[0][2])}]
    cum = 0.0
    for i in range(1, len(pts)):
        cum += _haversine_km(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
        prof.append({"km": round(cum, 4), "alt": round(pts[i][2])})
    raw = cum

    note = None
    scale = 1.0
    if official_length_km and raw:
        drift = abs(raw - official_length_km)
        if drift > MAX_RESCALE_DRIFT_KM:
            note = (f"track is {raw:.1f} km against an official {official_length_km} km "
                    f"({drift:.1f} km apart) -- looks like a different route, left unscaled")
        else:
            scale = official_length_km / raw
    if scale != 1.0:
        for p in prof:
            p["km"] = round(p["km"] * scale, 3)
    return {"profile": prof, "raw_km": round(raw, 2),
            "length_km": round(official_length_km, 2) if (official_length_km and not note)
                         else round(raw, 2),
            "scale": round(scale, 5), "note": note}


def altitude_at_km(profile: list[dict], km: float):
    """Elevation at a distance along the route, linearly interpolated.

    This is what lets a GPX elevation be dropped onto a km grid that came from
    somewhere else (ASO's profile.csv), which is how a full bundle gets GPX
    terrain while keeping ASO's checkpoints and timing.
    """
    if not profile:
        return None
    if km <= profile[0]["km"]:
        return profile[0]["alt"]
    if km >= profile[-1]["km"]:
        return profile[-1]["alt"]
    lo, hi = 0, len(profile) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if profile[mid]["km"] <= km:
            lo = mid
        else:
            hi = mid
    a, b = profile[lo], profile[hi]
    span = b["km"] - a["km"]
    if span <= 0:
        return a["alt"]
    return a["alt"] + (b["alt"] - a["alt"]) * ((km - a["km"]) / span)


def km_at_coords(pts, profile: list[dict], lon: float, lat: float):
    """Distance along the GPX track of the point nearest a coordinate.

    Two traces of one route disagree on distance -- velowire's starts at the
    départ fictif, so its km runs several kilometres ahead of the GPX's -- and
    the disagreement is not a constant offset, so no single shift reconciles
    them. Geography does: the same col is at the same latitude and longitude
    on both, whatever either calls its distance.

    This is what stops a marker drawn from one source landing in the wrong
    place on a profile drawn from the other -- stage 20 had an HC summit
    marked 5.2 km and 400 m off its own peak.

    `profile` must be the full-resolution output of profile_from_track for
    `pts`, so index i lines up in both.
    """
    if not pts or not profile:
        return None
    best_i, best_d = 0, float("inf")
    for i, (plo, pla, _e) in enumerate(pts):
        # Squared degrees is monotonic with real distance over the few hundred
        # metres that matter here, and avoids a haversine per track point.
        d = (plo - lon) ** 2 + (pla - lat) ** 2
        if d < best_d:
            best_d, best_i = d, i
    if best_i >= len(profile):
        return None
    return profile[best_i]["km"]


def downsample(points: list[dict], target: int = 400) -> list[dict]:
    """Thin for drawing, keeping each bucket's high and low so summits and
    valley floors survive -- same rule as the other profile builders."""
    if len(points) <= target:
        return points
    bucket = max(1, len(points) // (target // 2))
    out: list[dict] = []
    for i in range(0, len(points), bucket):
        chunk = points[i:i + bucket]
        if not chunk:
            continue
        hi = max(chunk, key=lambda p: p["alt"])
        lo = min(chunk, key=lambda p: p["alt"])
        for p in sorted({id(hi): hi, id(lo): lo}.values(), key=lambda p: p["km"]):
            if not out or out[-1]["km"] != p["km"]:
                out.append(p)
    return out


def load_stage(gpx_dir: Path, stage_number: int, official_length_km=None,
               with_points: bool = False):
    """Full-resolution profile for one stage, or None when no GPX exists.

    Some stages simply have no usable file -- 3, 4 and 5 downloaded as 404
    pages -- and every caller has a working fallback, so a missing stage is
    a None rather than an error.
    """
    path = Path(gpx_dir) / f"stage-{stage_number}.gpx"
    if not path.exists():
        return None
    try:
        pts = read_track(path)
    except ET.ParseError:
        return None
    if not pts:
        return None
    out = profile_from_track(pts, official_length_km)
    if with_points:
        out["points"] = pts          # needed to re-place markers by coordinate
    return out


def stage_lengths(year_dir: Path) -> dict[int, float]:
    """Official length per stage, for rescaling."""
    p = year_dir / "reference" / "stages.json"
    if not p.exists():
        return {}
    out = {}
    for s in json.loads(p.read_text(encoding="utf-8")):
        n = s.get("stage")
        if n is not None:
            out[n] = s.get("length") or s.get("lengthDisplay")
    return out
