"""Assemble one self-contained JSON bundle per stage for the Tour Navigator.

The browser extension loads exactly one of these files and needs nothing else,
so everything it draws or seeks to has to be in here: stage metadata, the
time-synced elevation profile, the guideposts, and the intensity curve.

Two deliberate choices:

* Distances are metres of elapsed route and every time is UTC ISO-8601. The
  extension converts UTC -> position-in-recording using the viewer's two-point
  anchor; keeping a single unambiguous clock in the data means a wrong anchor
  is a visible offset rather than a silent, timezone-shaped error.

* The profile is downsampled for rendering. A scrub bar is ~1000px wide, so
  1800+ route points is far more than can be seen; we keep peaks and troughs
  (never smoothing away a summit) and drop redundant points in between.
"""

from __future__ import annotations

import json
from pathlib import Path

from .elevation_sync import build as build_sync
from .extract_events import build_guideposts


def downsample_profile(points: list[dict], target: int = 500) -> list[dict]:
    """Thin the profile for drawing while preserving local extremes.

    Plain every-Nth sampling can land either side of a col and flatten it, so
    each bucket contributes its highest and lowest point; summits and valley
    floors therefore survive at any target size.
    """
    timed = [p for p in points if p.get("time_utc")]
    if len(timed) <= target:
        return timed
    bucket = max(1, len(timed) // (target // 2))
    out: list[dict] = []
    for i in range(0, len(timed), bucket):
        chunk = timed[i:i + bucket]
        if not chunk:
            continue
        hi = max(chunk, key=lambda p: p["altitude"])
        lo = min(chunk, key=lambda p: p["altitude"])
        for p in sorted({id(hi): hi, id(lo): lo}.values(), key=lambda p: p["km"]):
            if not out or out[-1]["km"] != p["km"]:
                out.append(p)
    return out


def _slim(p: dict) -> dict:
    """Only the fields the renderer reads, rounded to keep the bundle small."""
    return {
        "km": round(p["km"], 2),
        "alt": round(p["altitude"]),
        "t": p["time_utc"],
        "interp": bool(p.get("interpolated")),
        "cat": p.get("climb_category") or None,
        "cp": p.get("checkpoint_type") or None,
    }


def stage_meta(cfg_year_dir: Path, stage_number: int) -> dict:
    """Pull this stage's row out of the bootstrapped reference data."""
    path = cfg_year_dir / "reference" / "stages.json"
    if not path.exists():
        return {}
    for s in json.loads(path.read_text(encoding="utf-8")):
        if s.get("stage") == stage_number:
            return {
                "stage": s.get("stage"),
                "date": str(s.get("date", ""))[:10],
                "type": s.get("type"),
                "length_km": s.get("lengthDisplay") or s.get("length"),
                "start_local": s.get("startTime"),
                "end_local": s.get("endTime"),
                "timezone": s.get("timezone"),
                "departure": (s.get("departureCity") or {}).get("label"),
                "arrival": (s.get("arrivalCity") or {}).get("label"),
            }
    return {}


def build(stage_dir: Path, telemetry_path: Path, year_dir: Path,
          stage_number: int, out_path: Path | None = None) -> Path:
    meta = stage_meta(year_dir, stage_number)
    length_km = float(meta.get("length_km") or 0) or None
    if not length_km:
        raise SystemExit(f"stage {stage_number}: no length in stages.json; run bootstrap first")

    sync = build_sync(stage_dir, telemetry_path, length_km)
    events = build_guideposts(stage_dir, sync["points"])
    profile = [_slim(p) for p in downsample_profile(sync["points"])]

    bundle = {
        "schema": 1,
        "stage": meta,
        "coverage": {
            "gps_samples": sync["gps_samples"],
            "profile_points_total": sync["profile_points"],
            "profile_points_observed": sync["observed_points"],
            "leader_first_seen_utc": sync["leader_first_seen"],
            "leader_last_seen_utc": sync["leader_last_seen"],
            "ticker_items": events["ticker_items"],
        },
        "profile": profile,
        "guideposts": events["guideposts"],
        "intensity": events["intensity"],
    }

    out_path = out_path or (stage_dir / "navigator.json")
    out_path.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
    kb = out_path.stat().st_size / 1024
    print(f"[navigator] stage {stage_number} -> {out_path} ({kb:.0f} KB)")
    print(f"[navigator]   profile {len(profile)} pts (of {sync['profile_points']}), "
          f"{sync['observed_points']} time-observed")
    print(f"[navigator]   guideposts {events['counts']}")
    return out_path
